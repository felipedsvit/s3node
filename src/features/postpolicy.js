import { S3Error } from '../errors.js'
import { ALGORITHM, calculateSignature, deriveSigningKey, signaturesMatch } from '../auth/sigv4.js'

const MAX_POLICY_BYTES = 20 * 1024

/**
 * Fields the browser always sends that do not themselves need a matching
 * policy condition.
 */
const EXEMPT_FIELDS = new Set([
  'policy', 'x-amz-signature', 'x-amz-algorithm', 'x-amz-credential', 'x-amz-date',
  'x-amz-security-token', 'file', 'signature', 'awsaccesskeyid',
])

function parseCredential(credential) {
  const parts = String(credential ?? '').split('/')
  if (parts.length !== 5 || parts[4] !== 'aws4_request') {
    throw new S3Error('AuthorizationHeaderMalformed', 'Malformed x-amz-credential')
  }
  return { accessKeyId: parts[0], date: parts[1], region: parts[2], service: parts[3] }
}

function conditionValue(fields, name) {
  return fields.get(String(name).toLowerCase())
}

/**
 * Validates the decoded policy against the submitted fields.
 *
 * Every condition must hold, and every submitted field must be covered by some
 * condition. The second half is the important one: without it a form signed for
 * `uploads/` could carry any other field the server acts on.
 */
function validateConditions(policy, fields, { contentLength }) {
  if (!Array.isArray(policy.conditions)) {
    throw new S3Error('MalformedPOSTRequest', 'The policy requires a conditions array')
  }
  const covered = new Set(EXEMPT_FIELDS)
  let range = null

  for (const condition of policy.conditions) {
    if (Array.isArray(condition)) {
      const [operator, target, ...rest] = condition
      const op = String(operator).toLowerCase()

      if (op === 'content-length-range') {
        range = { min: Number(target), max: Number(rest[0]) }
        continue
      }

      const name = String(target ?? '').replace(/^\$/, '').toLowerCase()
      covered.add(name)
      const actual = conditionValue(fields, name)
      if (op === 'eq') {
        if (actual !== String(rest[0])) {
          throw new S3Error('AccessDenied', `Policy condition failed: ${name} must equal "${rest[0]}"`)
        }
      } else if (op === 'starts-with') {
        const prefix = String(rest[0] ?? '')
        if (actual === undefined || !actual.startsWith(prefix)) {
          throw new S3Error('AccessDenied', `Policy condition failed: ${name} must start with "${prefix}"`)
        }
      } else {
        throw new S3Error('MalformedPOSTRequest', `Unsupported policy condition ${operator}`)
      }
      continue
    }

    if (!condition || typeof condition !== 'object') {
      throw new S3Error('MalformedPOSTRequest', 'Malformed policy condition')
    }
    for (const [rawName, expected] of Object.entries(condition)) {
      const name = rawName.toLowerCase()
      covered.add(name)
      if (conditionValue(fields, name) !== String(expected)) {
        throw new S3Error('AccessDenied', `Policy condition failed: ${name} must equal "${expected}"`)
      }
    }
  }

  for (const name of fields.keys()) {
    if (!covered.has(name)) {
      throw new S3Error('AccessDenied', `Field ${name} is not covered by the policy`)
    }
  }

  if (range && contentLength !== undefined) {
    if (contentLength < range.min || contentLength > range.max) {
      throw new S3Error('EntityTooLarge',
        `The uploaded body must be between ${range.min} and ${range.max} bytes`)
    }
  }
  return { range }
}

/**
 * Verifies a browser POST upload. The signature is taken over the base64 policy
 * string exactly as submitted, so it must not be re-encoded before signing.
 */
export function verifyPostPolicy({ fields, bucket, lookupCredential, now = Date.now(), contentLength }) {
  const encodedPolicy = fields.get('policy')
  if (!encodedPolicy) throw new S3Error('AccessDenied', 'The POST request is missing a policy')
  if (encodedPolicy.length > MAX_POLICY_BYTES) {
    throw new S3Error('MalformedPOSTRequest', 'The policy exceeds the maximum accepted size')
  }

  const algorithm = fields.get('x-amz-algorithm')
  if (algorithm !== ALGORITHM) {
    throw new S3Error('AccessDenied', 'Unsupported or missing x-amz-algorithm')
  }
  const signature = fields.get('x-amz-signature')
  if (!signature) throw new S3Error('AccessDenied', 'The POST request is missing a signature')

  const { accessKeyId, date, region, service } = parseCredential(fields.get('x-amz-credential'))
  if (service !== 's3') throw new S3Error('AuthorizationHeaderMalformed', 'Credential must be scoped to s3')

  const credential = lookupCredential(accessKeyId)
  if (!credential) throw new S3Error('InvalidAccessKeyId')

  let policy
  try {
    policy = JSON.parse(Buffer.from(encodedPolicy, 'base64').toString('utf8'))
  } catch {
    throw new S3Error('MalformedPOSTRequest', 'The policy is not valid base64-encoded JSON')
  }

  if (!policy.expiration || Number.isNaN(Date.parse(policy.expiration))) {
    throw new S3Error('MalformedPOSTRequest', 'The policy requires an expiration')
  }
  if (now > Date.parse(policy.expiration)) throw new S3Error('AccessDenied', 'The policy has expired')

  const expected = calculateSignature(
    deriveSigningKey(credential.secretAccessKey, date, region, service, accessKeyId),
    encodedPolicy,
  )
  if (!signaturesMatch(expected, signature)) throw new S3Error('SignatureDoesNotMatch')

  if (fields.get('bucket') !== undefined && fields.get('bucket') !== bucket) {
    throw new S3Error('AccessDenied', 'The policy was signed for a different bucket')
  }

  const { range } = validateConditions(policy, fields, { contentLength })
  return { accessKeyId, policy, range }
}

/** S3 substitutes `${filename}` in the key with the uploaded file name. */
export function resolveKey(rawKey, filename) {
  if (!rawKey) throw new S3Error('MalformedPOSTRequest', 'The POST request is missing a key')
  return rawKey.replaceAll('${filename}', filename ?? '')
}
