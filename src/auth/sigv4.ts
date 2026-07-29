import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { S3Error } from '../errors.js'
import type { RequestContext } from '../http.js'
import type { Credential } from './credentials.js'

export const ALGORITHM = 'AWS4-HMAC-SHA256'
export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD'
export const STREAMING_SIGNED = 'STREAMING-AWS4-HMAC-SHA256-PAYLOAD'
export const STREAMING_SIGNED_TRAILER = 'STREAMING-AWS4-HMAC-SHA256-PAYLOAD-TRAILER'
export const STREAMING_UNSIGNED_TRAILER = 'STREAMING-UNSIGNED-PAYLOAD-TRAILER'

export const STREAMING_PAYLOADS = new Set([
  STREAMING_SIGNED,
  STREAMING_SIGNED_TRAILER,
  STREAMING_UNSIGNED_TRAILER,
])

const MAX_SKEW_MS = 15 * 60 * 1000
const MAX_PRESIGN_EXPIRY = 7 * 24 * 60 * 60

export function uriEncode(value: string, encodeSlash = true): string {
  const bytes = Buffer.from(String(value), 'utf8')
  let out = ''
  for (const byte of bytes) {
    const char = String.fromCharCode(byte)
    if ((byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a) ||
        (byte >= 0x30 && byte <= 0x39) || char === '-' || char === '.' ||
        char === '_' || char === '~') {
      out += char
    } else if (char === '/' && !encodeSlash) {
      out += char
    } else {
      out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
    }
  }
  return out
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest()
}

const signingKeyCache = new Map<string, Buffer>()
const SIGNING_KEY_CACHE_LIMIT = 512

export function deriveSigningKey(secretAccessKey: string, date: string, region: string, service = 's3', accessKeyId = ''): Buffer {
  const secretFingerprint = createHash('sha256').update(secretAccessKey, 'utf8').digest('base64')
  const cacheKey = `${accessKeyId}/${date}/${region}/${service}/${secretFingerprint}`
  const cached = signingKeyCache.get(cacheKey)
  if (cached) return cached
  const kDate = hmac(`AWS4${secretAccessKey}`, date)
  const kRegion = hmac(kDate, region)
  const kService = hmac(kRegion, service)
  const kSigning = hmac(kService, 'aws4_request')
  if (signingKeyCache.size >= SIGNING_KEY_CACHE_LIMIT) {
    const firstKey = signingKeyCache.keys().next().value
    if (firstKey !== undefined) signingKeyCache.delete(firstKey)
  }
  signingKeyCache.set(cacheKey, kSigning)
  return kSigning
}

export function normalizeHeaderValue(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value.join(',') : String(value ?? '')
  return raw.trim().replace(/\s+/g, ' ')
}

export function canonicalQueryString(pairs: [string, string][]): string {
  return pairs
    .map(([name, value]) => [uriEncode(name), uriEncode(value ?? '')] as [string, string])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join('&')
}

export function buildCanonicalRequest({ method, canonicalUri, queryPairs, headers, signedHeaders, payloadHash }: {
  method: string | undefined
  canonicalUri: string
  queryPairs: [string, string][]
  headers: IncomingMessage['headers']
  signedHeaders: string[]
  payloadHash: string
}): string {
  const canonicalHeaders = signedHeaders
    .map((name) => `${name}:${normalizeHeaderValue(headers[name])}\n`)
    .join('')
  return [
    method,
    canonicalUri || '/',
    canonicalQueryString(queryPairs),
    canonicalHeaders,
    signedHeaders.join(';'),
    payloadHash,
  ].join('\n')
}

export function buildStringToSign({ amzDate, scope, canonicalRequest }: {
  amzDate: string
  scope: string
  canonicalRequest: string
}): string {
  return [
    ALGORITHM,
    amzDate,
    scope,
    createHash('sha256').update(canonicalRequest, 'utf8').digest('hex'),
  ].join('\n')
}

export function calculateSignature(signingKey: Buffer, stringToSign: string): string {
  return createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex')
}

export function chunkStringToSign({ amzDate, scope, previousSignature, chunkSha256 }: {
  amzDate: string | null
  scope: string | null
  previousSignature: string
  chunkSha256: string
}): string {
  return [
    'AWS4-HMAC-SHA256-PAYLOAD',
    amzDate,
    scope,
    previousSignature,
    EMPTY_SHA256,
    chunkSha256,
  ].join('\n')
}

export function trailerStringToSign({ amzDate, scope, previousSignature, trailerSha256 }: {
  amzDate: string | null
  scope: string | null
  previousSignature: string
  trailerSha256: string
}): string {
  return [
    'AWS4-HMAC-SHA256-TRAILER',
    amzDate,
    scope,
    previousSignature,
    trailerSha256,
  ].join('\n')
}

export function signaturesMatch(expected: string, provided: string | undefined | null): boolean {
  if (typeof provided !== 'string' || expected.length !== provided.length) return false
  return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(provided, 'utf8'))
}

export function parseAmzDate(amzDate: string | undefined | null): Date | null {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(amzDate ?? '')
  if (!match) return null
  const [, y, mo, d, h, mi, s] = match
  return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)))
}

interface ParsedCredential {
  accessKeyId: string
  date: string
  region: string
  service: string
  scope: string
}

function parseCredentialScope(credential: string): ParsedCredential {
  const parts = String(credential ?? '').split('/')
  if (parts.length !== 5 || parts[4] !== 'aws4_request') {
    throw new S3Error('AuthorizationHeaderMalformed', 'Credential should be scoped with a valid terminator')
  }
  const [accessKeyId, date, region, service] = parts
  return { accessKeyId: accessKeyId!, date: date!, region: region!, service: service!, scope: parts.slice(1).join('/') }
}

interface ParsedAuthorization {
  accessKeyId: string
  date: string
  region: string
  service: string
  scope: string
  signedHeaders: string[]
  signature: string
}

function parseAuthorizationHeader(header: string): ParsedAuthorization {
  if (!header.startsWith(`${ALGORITHM} `)) {
    throw new S3Error('AuthorizationHeaderMalformed', 'Unsupported signature algorithm')
  }
  const fields: Record<string, string> = {}
  for (const part of header.slice(ALGORITHM.length + 1).split(',')) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    fields[part.slice(0, idx).trim()] = part.slice(idx + 1).trim()
  }
  if (!fields['Credential'] || !fields['SignedHeaders'] || !fields['Signature']) {
    throw new S3Error('AuthorizationHeaderMalformed', 'Authorization header is missing required fields')
  }
  return {
    ...parseCredentialScope(fields['Credential']),
    signedHeaders: fields['SignedHeaders'].split(';').map((h) => h.toLowerCase()).filter(Boolean),
    signature: fields['Signature'],
  }
}

function assertFreshness(requestDate: Date | null, now: number, code = 'RequestTimeTooSkewed'): void {
  if (!requestDate) throw new S3Error('AuthorizationHeaderMalformed', 'Invalid x-amz-date')
  if (Math.abs(now - requestDate.getTime()) > MAX_SKEW_MS) {
    throw new S3Error(code, 'The difference between the request time and the current time is too large')
  }
}

export interface VerifyResult {
  accessKeyId: string
  region: string
  scope: string
  amzDate: string
  payloadHash: string
  presigned: boolean
  seedSignature: string
  signingKey: Buffer
  canonicalRequest: string
  stringToSign: string
}

export function verifyRequest(ctx: RequestContext, { lookupCredential, now = Date.now(), region = 'us-east-1' }: {
  lookupCredential: (accessKeyId: string) => Credential | undefined
  now?: number
  region?: string
}): VerifyResult {
  const headers = ctx.headers
  const authorization = headers.authorization
  const presigned = !authorization && ctx.query.get('X-Amz-Signature') !== undefined

  if (!authorization && !presigned) {
    throw new S3Error('AccessDenied', 'Anonymous access is not supported')
  }

  let parsed: ParsedAuthorization
  let amzDate: string
  let payloadHash: string
  let queryPairs = ctx.queryPairs

  if (presigned) {
    const credential = ctx.query.get('X-Amz-Credential')
    const signedHeaders = (ctx.query.get('X-Amz-SignedHeaders') ?? '')
      .split(';').map((h) => h.toLowerCase()).filter(Boolean)
    parsed = {
      ...parseCredentialScope(credential ?? ''),
      signedHeaders,
      signature: ctx.query.get('X-Amz-Signature') ?? '',
    }
    if (ctx.query.get('X-Amz-Algorithm') !== ALGORITHM) {
      throw new S3Error('AuthorizationHeaderMalformed', 'Unsupported signature algorithm')
    }
    amzDate = ctx.query.get('X-Amz-Date') ?? ''
    const requestDate = parseAmzDate(amzDate)
    if (!requestDate) throw new S3Error('AuthorizationHeaderMalformed', 'Invalid X-Amz-Date')
    const expires = Number.parseInt(ctx.query.get('X-Amz-Expires') ?? '', 10)
    if (!Number.isInteger(expires) || expires <= 0 || expires > MAX_PRESIGN_EXPIRY) {
      throw new S3Error('AuthorizationHeaderMalformed', 'X-Amz-Expires must be between 1 and 604800 seconds')
    }
    if (now > requestDate.getTime() + expires * 1000) {
      throw new S3Error('AccessDenied', 'Request has expired')
    }
    if (requestDate.getTime() - now > MAX_SKEW_MS) {
      throw new S3Error('RequestTimeTooSkewed', 'Request is dated too far in the future')
    }
    payloadHash = String(headers['x-amz-content-sha256'] ?? UNSIGNED_PAYLOAD)
    queryPairs = ctx.queryPairs.filter(([name]) => name !== 'X-Amz-Signature')
  } else {
    parsed = parseAuthorizationHeader(authorization!)
    amzDate = String(headers['x-amz-date'] ?? '')
    assertFreshness(parseAmzDate(amzDate), now)
    payloadHash = String(headers['x-amz-content-sha256'] ?? '')
    if (!payloadHash) {
      throw new S3Error('InvalidRequest', 'Missing required header x-amz-content-sha256')
    }
  }

  if (!parsed.signedHeaders.includes('host')) {
    throw new S3Error('AuthorizationHeaderMalformed', 'The host header must be signed')
  }
  if (parsed.service !== 's3') {
    throw new S3Error('AuthorizationHeaderMalformed', `Credential should be scoped to service: s3`)
  }

  const credential = lookupCredential(parsed.accessKeyId)
  if (!credential) {
    throw new S3Error('InvalidAccessKeyId', 'The AWS Access Key Id you provided does not exist in our records')
  }

  const canonicalRequest = buildCanonicalRequest({
    method: ctx.method,
    canonicalUri: ctx.rawPath,
    queryPairs,
    headers,
    signedHeaders: parsed.signedHeaders,
    payloadHash,
  })
  const stringToSign = buildStringToSign({ amzDate, scope: parsed.scope, canonicalRequest })
  const signingKey = deriveSigningKey(
    credential.secretAccessKey, parsed.date, parsed.region, parsed.service, parsed.accessKeyId,
  )
  const expected = calculateSignature(signingKey, stringToSign)

  if (!signaturesMatch(expected, parsed.signature)) {
    const error = new S3Error('SignatureDoesNotMatch')
    error.detail.canonicalRequest = canonicalRequest
    error.detail.stringToSign = stringToSign
    throw error
  }

  return {
    accessKeyId: parsed.accessKeyId,
    region: parsed.region,
    scope: parsed.scope,
    amzDate,
    payloadHash,
    presigned,
    seedSignature: expected,
    signingKey,
    canonicalRequest,
    stringToSign,
  }
}
