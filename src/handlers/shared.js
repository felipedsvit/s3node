import { S3Error } from '../errors.js'
import { CHECKSUM_ALGORITHMS } from '../util/hash.js'
import { text } from '../xml.js'

export const MAX_DELETE_KEYS = 1000
export const OWNER_ID = 's3node'
export const OWNER_DISPLAY_NAME = 's3node'

export const ownerXml = `<Owner>${text('ID', OWNER_ID)}${text('DisplayName', OWNER_DISPLAY_NAME)}</Owner>`

export function maybeEncode(value, encodingType) {
  return encodingType === 'url' ? encodeURIComponent(value) : value
}

export function integerParam(query, name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = query.get(name)
  if (raw === undefined || raw === '') return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new S3Error('InvalidArgument', `Invalid value for ${name}`)
  }
  return parsed
}

/**
 * Collects everything the request declared about body integrity: Content-MD5,
 * the literal payload SHA-256 (when not streaming/unsigned) and the
 * `x-amz-checksum-*` family, which modern SDKs send by default as a trailer
 * (docs/plan.md section 4.2).
 */
export function integrityOptions(ctx) {
  const headers = ctx.headers
  const payloadHash = ctx.auth?.payloadHash
  const literalSha256 = /^[0-9a-f]{64}$/.test(payloadHash ?? '') ? payloadHash : null

  let checksumAlgorithm = null
  let expectedChecksum = null
  for (const algorithm of CHECKSUM_ALGORITHMS) {
    const value = headers[`x-amz-checksum-${algorithm}`]
    if (value !== undefined) {
      checksumAlgorithm = algorithm
      expectedChecksum = String(value)
      break
    }
  }
  if (!checksumAlgorithm) {
    const declared = headers['x-amz-trailer'] ?? headers['x-amz-sdk-checksum-algorithm']
    const match = /(crc32c|crc32|sha256|sha1)/i.exec(String(declared ?? ''))
    if (match) checksumAlgorithm = match[1].toLowerCase()
  }

  return {
    contentMd5: headers['content-md5'] ? String(headers['content-md5']) : null,
    expectedSha256: literalSha256,
    checksumAlgorithm,
    expectedChecksum,
    trailerProvider: ctx.trailers ? (name) => ctx.trailers[name] ?? null : null,
  }
}

export function checksumHeaders(checksums) {
  const headers = {}
  for (const [algorithm, value] of Object.entries(checksums ?? {})) {
    headers[`x-amz-checksum-${algorithm}`] = value
  }
  return headers
}

/** `x-amz-version-id` is only meaningful once the bucket has been versioned. */
export function versionHeaders(result) {
  return result?.versioned && result.versionId ? { 'x-amz-version-id': result.versionId } : {}
}

export function sseRequest(ctx, store, { copySource = false } = {}) {
  const prefix = copySource
    ? 'x-amz-copy-source-server-side-encryption'
    : 'x-amz-server-side-encryption'
  return store.encryption.parseRequest(ctx.headers, { prefix })
}

/** Fire-and-forget event delivery; never allowed to fail the request. */
export function notify(server, event) {
  server?.notifications?.dispatch(event)
}
