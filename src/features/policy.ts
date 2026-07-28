import { S3Error } from '../errors.js'

const MAX_POLICY_BYTES = 20 * 1024

/**
 * IAM wildcards: `*` matches any run of characters, `?` matches exactly one.
 * Both are translated in the same pass as the regex escaping — a second pass
 * would rewrite the backslash-escaped `\?` produced by the first one.
 */
function wildcardToRegExp(pattern: string): RegExp {
  const body = String(pattern).replace(/[.*+?^${}()|[\]\\]/g, (char) => {
    if (char === '*') return '.*'
    if (char === '?') return '.'
    return `\\${char}`
  })
  return new RegExp(`^${body}$`)
}

function matchesWildcard(pattern: string, value: string | undefined | null): boolean {
  if (pattern === '*') return true
  if (value === undefined || value === null) return false
  return wildcardToRegExp(pattern).test(String(value))
}

function toArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value : [value]
}

function ipv4ToInt(address: string): number | null {
  const parts = address.split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    const octet = Number(part)
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null
    value = value * 256 + octet
  }
  return value
}

export function ipInCidr(address: string, cidr: string): boolean {
  const [network, bitsRaw] = String(cidr).split('/')
  const bits = bitsRaw === undefined ? 32 : Number(bitsRaw)
  const target = ipv4ToInt(String(address).replace(/^::ffff:/, ''))
  const base = ipv4ToInt(network!)
  if (target === null || base === null || !Number.isInteger(bits) || bits < 0 || bits > 32) {
    return String(address) === String(network)
  }
  if (bits === 0) return true
  const mask = (0xffffffff << (32 - bits)) >>> 0
  return ((target & mask) >>> 0) === ((base & mask) >>> 0)
}

const CONDITION_OPERATORS: Record<string, (actual: unknown, expected: string) => boolean> = {
  StringEquals: (actual, expected) => actual !== undefined && String(actual) === String(expected),
  StringNotEquals: (actual, expected) => !(actual !== undefined && String(actual) === String(expected)),
  StringEqualsIgnoreCase: (actual, expected) =>
    actual !== undefined && String(actual).toLowerCase() === String(expected).toLowerCase(),
  StringLike: (actual, expected) => matchesWildcard(expected, actual as string | undefined | null),
  StringNotLike: (actual, expected) => !matchesWildcard(expected, actual as string | undefined | null),
  Bool: (actual, expected) => String(actual) === String(expected),
  IpAddress: (actual, expected) => actual !== undefined && ipInCidr(actual as string, expected),
  NotIpAddress: (actual, expected) => !(actual !== undefined && ipInCidr(actual as string, expected)),
  NumericEquals: (actual, expected) => Number(actual) === Number(expected),
  NumericLessThan: (actual, expected) => Number(actual) < Number(expected),
  NumericGreaterThan: (actual, expected) => Number(actual) > Number(expected),
  Null: (actual, expected) => (String(expected) === 'true') === (actual === undefined || actual === null),
}

export const SUPPORTED_CONDITION_OPERATORS = Object.keys(CONDITION_OPERATORS)

/** A statement's `Condition` block: operator name -> context key -> expected value(s). */
export type ConditionBlock = Record<string, Record<string, string | string[]>>

interface ResolvedOperator {
  apply: (actual: unknown, expected: string) => boolean
  /** The `...IfExists` suffix: skip the test when the context key is absent. */
  ifExists: boolean
}

function resolveOperator(rawOperator: string): ResolvedOperator {
  const ifExists = rawOperator.endsWith('IfExists')
  const name = ifExists ? rawOperator.slice(0, -'IfExists'.length) : rawOperator
  const apply = CONDITION_OPERATORS[name]
  if (!apply) throw new S3Error('MalformedPolicy', `Unsupported condition operator ${rawOperator}`)
  return { apply, ifExists }
}

/**
 * Validation only — checks every operator in the block, with no evaluation.
 *
 * This has to be separate from `evaluateConditions`: that function short-
 * circuits on the first unsatisfied test, so using it to validate would leave
 * operators after that point unchecked, and the policy would only blow up later
 * on an unrelated request.
 */
function assertKnownOperators(condition: ConditionBlock | undefined | null): void {
  if (!condition) return
  for (const rawOperator of Object.keys(condition)) resolveOperator(rawOperator)
}

function evaluateConditions(condition: ConditionBlock | undefined | null, context: Record<string, string | undefined | null>): boolean {
  if (!condition) return true
  for (const [rawOperator, tests] of Object.entries(condition)) {
    const { apply, ifExists } = resolveOperator(rawOperator)

    for (const [key, expectedValues] of Object.entries(tests)) {
      const actual = context[key.toLowerCase()]
      if (ifExists && (actual === undefined || actual === null)) continue
      const satisfied = toArray(expectedValues).some((expected) => apply(actual, expected))
      if (!satisfied) return false
    }
  }
  return true
}

function principalMatches(principal: string | { AWS?: string | string[] } | undefined, context: Record<string, string | undefined | null>): boolean {
  if (principal === undefined) return true
  if (principal === '*') return true
  if (typeof principal === 'string') return matchesWildcard(principal, context.principal)
  const aws = toArray(principal.AWS)
  if (aws.length === 0) return false
  return aws.some((entry) => entry === '*' || matchesWildcard(entry, context.principal))
}

export interface PolicyStatement {
  Effect: 'Allow' | 'Deny'
  Action?: string | string[]
  NotAction?: string | string[]
  Resource?: string | string[]
  NotResource?: string | string[]
  Principal?: string | { AWS?: string | string[] }
  NotPrincipal?: string | { AWS?: string | string[] }
  Condition?: ConditionBlock
}

export interface PolicyDocument {
  Statement: PolicyStatement[]
}

function statementMatchesTarget(statement: PolicyStatement, { action, resource, context }: {
  action: string
  resource: string
  context: Record<string, string | undefined | null>
}): boolean {
  const actions = toArray(statement.Action)
  const notActions = toArray(statement.NotAction)
  if (actions.length && !actions.some((pattern) => matchesWildcard(pattern, action))) return false
  if (notActions.length && notActions.some((pattern) => matchesWildcard(pattern, action))) return false

  const resources = toArray(statement.Resource)
  const notResources = toArray(statement.NotResource)
  if (resources.length && !resources.some((pattern) => matchesWildcard(pattern, resource))) return false
  if (notResources.length && notResources.some((pattern) => matchesWildcard(pattern, resource))) return false

  if (!principalMatches(statement.Principal, context)) return false
  if (statement.NotPrincipal && principalMatches(statement.NotPrincipal, context)) return false

  return evaluateConditions(statement.Condition, context)
}

export function parsePolicy(body: string | Buffer): PolicyDocument {
  const text = Buffer.isBuffer(body) ? body.toString('utf8') : String(body)
  if (text.length > MAX_POLICY_BYTES) {
    throw new S3Error('MalformedPolicy', 'The policy document exceeds the maximum accepted size')
  }
  let policy
  try {
    policy = JSON.parse(text)
  } catch {
    throw new S3Error('MalformedPolicy', 'The policy is not valid JSON')
  }
  if (!policy || typeof policy !== 'object' || !Array.isArray(policy.Statement)) {
    throw new S3Error('MalformedPolicy', 'A policy requires a Statement array')
  }
  for (const statement of policy.Statement) {
    if (statement.Effect !== 'Allow' && statement.Effect !== 'Deny') {
      throw new S3Error('MalformedPolicy', 'Each statement requires an Effect of Allow or Deny')
    }
    if (!statement.Action && !statement.NotAction) {
      throw new S3Error('MalformedPolicy', 'Each statement requires an Action')
    }
    assertKnownOperators(statement.Condition)
  }
  return policy
}

export function evaluatePolicy(policy: PolicyDocument | null | undefined, target: {
  action: string
  resource: string
  context: Record<string, string | undefined | null>
}): 'Allow' | 'Deny' | 'NoDecision' {
  if (!policy) return 'NoDecision'
  let allowed = false
  for (const statement of policy.Statement) {
    if (!statementMatchesTarget(statement, target)) continue
    if (statement.Effect === 'Deny') return 'Deny'
    allowed = true
  }
  return allowed ? 'Allow' : 'NoDecision'
}

export function bucketArn(bucket: string): string {
  return `arn:aws:s3:::${bucket}`
}

export function objectArn(bucket: string, key: string): string {
  return `arn:aws:s3:::${bucket}/${key}`
}
