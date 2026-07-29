import { S3Error } from '../errors.js'
import { childText, childrenNamed, document, parseXml, text } from '../xml.js'

const MAX_RULES = 100

export interface CorsRule {
  id?: string | undefined
  allowedOrigins: string[]
  allowedMethods: string[]
  allowedHeaders: string[]
  exposeHeaders: string[]
  maxAgeSeconds?: number | undefined
}

export interface CorsConfig {
  rules: CorsRule[]
}

function ruleValues(rule: ReturnType<typeof parseXml>, name: string): string[] {
  return childrenNamed(rule, name).map((child) => child.text)
}

export function parseCorsXml(body: string | Buffer): CorsConfig {
  const root = parseXml(body)
  if (root.name !== 'CORSConfiguration') {
    throw new S3Error('MalformedXML', 'Expected a CORSConfiguration element')
  }
  const rules = childrenNamed(root, 'CORSRule').map((rule) => {
    const allowedOrigins = ruleValues(rule, 'AllowedOrigin')
    const allowedMethods = ruleValues(rule, 'AllowedMethod').map((method) => method.toUpperCase())
    if (allowedOrigins.length === 0 || allowedMethods.length === 0) {
      throw new S3Error('MalformedXML', 'Each CORSRule requires AllowedOrigin and AllowedMethod')
    }
    const maxAge = childText(rule, 'MaxAgeSeconds')
    return {
      id: childText(rule, 'ID'),
      allowedOrigins,
      allowedMethods,
      allowedHeaders: ruleValues(rule, 'AllowedHeader').map((header) => header.toLowerCase()),
      exposeHeaders: ruleValues(rule, 'ExposeHeader'),
      maxAgeSeconds: maxAge === undefined ? undefined : Number.parseInt(maxAge, 10),
    }
  })
  if (rules.length === 0) throw new S3Error('MalformedXML', 'At least one CORSRule is required')
  if (rules.length > MAX_RULES) {
    throw new S3Error('MalformedXML', `A maximum of ${MAX_RULES} CORS rules is allowed`)
  }
  return { rules }
}

export function corsXml(config: CorsConfig): string {
  const rules = (config?.rules ?? []).map((rule) => (
    '<CORSRule>' +
    (rule.id ? text('ID', rule.id) : '') +
    rule.allowedOrigins.map((origin) => text('AllowedOrigin', origin)).join('') +
    rule.allowedMethods.map((method) => text('AllowedMethod', method)).join('') +
    rule.allowedHeaders.map((header) => text('AllowedHeader', header)).join('') +
    rule.exposeHeaders.map((header) => text('ExposeHeader', header)).join('') +
    (rule.maxAgeSeconds === undefined ? '' : text('MaxAgeSeconds', rule.maxAgeSeconds)) +
    '</CORSRule>'
  )).join('')
  return document('CORSConfiguration', rules)
}

function originMatches(pattern: string, origin: string): boolean {
  if (pattern === '*') return true
  const star = pattern.indexOf('*')
  if (star === -1) return pattern === origin
  const prefix = pattern.slice(0, star)
  const suffix = pattern.slice(star + 1)
  return origin.length >= prefix.length + suffix.length &&
    origin.startsWith(prefix) && origin.endsWith(suffix)
}

function headersAllowed(rule: CorsRule, requested: string[]): boolean {
  if (requested.length === 0) return true
  if (rule.allowedHeaders.includes('*')) return true
  return requested.every((header) => rule.allowedHeaders.includes(header))
}

export function matchRule(config: CorsConfig | null | undefined, { origin, method, requestHeaders = [] }: {
  origin: string
  method: string
  requestHeaders?: string[]
}): CorsRule | null {
  if (!config?.rules || !origin) return null
  for (const rule of config.rules) {
    if (!rule.allowedOrigins.some((pattern) => originMatches(pattern, origin))) continue
    if (!rule.allowedMethods.includes(method)) continue
    if (!headersAllowed(rule, requestHeaders)) continue
    return rule
  }
  return null
}

export function parseRequestHeaders(header: string | undefined): string[] {
  return String(header ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
}

export function responseHeaders(rule: CorsRule | null, origin: string): Record<string, string> {
  if (!rule) return { Vary: 'Origin' }
  const headers: Record<string, string> = {
    'Access-Control-Allow-Origin': rule.allowedOrigins.includes('*') ? '*' : origin,
    'Access-Control-Allow-Methods': rule.allowedMethods.join(', '),
    Vary: 'Origin',
  }
  if (rule.exposeHeaders.length) {
    headers['Access-Control-Expose-Headers'] = rule.exposeHeaders.join(', ')
  }
  if (rule.maxAgeSeconds !== undefined) {
    headers['Access-Control-Max-Age'] = String(rule.maxAgeSeconds)
  }
  return headers
}

export function preflightHeaders(rule: CorsRule, origin: string, requestHeaders: string[]): Record<string, string> {
  const headers = responseHeaders(rule, origin)
  if (requestHeaders.length) {
    headers['Access-Control-Allow-Headers'] = rule.allowedHeaders.includes('*')
      ? requestHeaders.join(', ')
      : rule.allowedHeaders.filter((header) => requestHeaders.includes(header)).join(', ')
  }
  return headers
}
