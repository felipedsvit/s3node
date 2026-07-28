import { S3Error } from '../errors.js'
import { CHECKSUM_ALGORITHMS } from '../util/hash.js'
import { text } from '../xml.js'
import type { SseRequest } from '../features/encryption.js'
import type { NotificationDispatcher } from '../features/notifications.js'
import type { EncryptionManager } from '../features/encryption.js'
import type { RequestContext } from '../http.js'

export const MAX_DELETE_KEYS = 1000
export const OWNER_ID = 's3node'
export const OWNER_DISPLAY_NAME = 's3node'

export const ownerXml = `<Owner>${text('ID', OWNER_ID)}${text('DisplayName', OWNER_DISPLAY_NAME)}</Owner>`

export function maybeEncode(value: string, encodingType: string): string {
  return encodingType === 'url' ? encodeURIComponent(value) : value
}

export function integerParam(query: Map<string, string>, name: string, fallback: number, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}): number {
  const raw = query.get(name)
  if (raw === undefined || raw === '') return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new S3Error('InvalidArgument', `Invalid value for ${name}`)
  }
  return parsed
}

export function integrityOptions(ctx: RequestContext): {
  contentMd5: string | null
  expectedSha256: string | null
  checksumAlgorithm: string | null
  expectedChecksum: string | null
  trailerProvider: ((name: string) => string | null) | null
} {
  const headers = ctx.headers
  const payloadHash = ctx.auth?.payloadHash as string | undefined
  const literalSha256 = /^[0-9a-f]{64}$/.test(payloadHash ?? '') ? payloadHash ?? null : null

  let checksumAlgorithm: string | null = null
  let expectedChecksum: string | null = null
  for (const algorithm of CHECKSUM_ALGORITHMS) {
    const value = headers[`x-amz-checksum-${algorithm}`]
    if (value !== undefined) {
      checksumAlgorithm = algorithm
      expectedChecksum = String(value)
      break
    }
  }
  if (!checksumAlgorithm) {
    const declared = String(headers['x-amz-trailer'] ?? headers['x-amz-sdk-checksum-algorithm'] ?? '')
    const match = /(crc32c|crc32|sha256|sha1)/i.exec(declared)
    if (match) checksumAlgorithm = match[1]!.toLowerCase()
  }

  return {
    contentMd5: headers['content-md5'] ? String(headers['content-md5']) : null,
    expectedSha256: literalSha256,
    checksumAlgorithm,
    expectedChecksum,
    trailerProvider: ctx.trailers ? (name: string) => ctx.trailers![name] ?? null : null,
  }
}

export function checksumHeaders(checksums: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [algorithm, value] of Object.entries(checksums ?? {})) {
    headers[`x-amz-checksum-${algorithm}`] = value
  }
  return headers
}

export function versionHeaders(result: { versioned?: boolean; versionId?: string }): Record<string, string> {
  return result?.versioned && result.versionId ? { 'x-amz-version-id': result.versionId } : {}
}

export function sseRequest(ctx: RequestContext, store: { encryption: EncryptionManager }, { copySource = false } = {}): SseRequest | null {
  const prefix = copySource
    ? 'x-amz-copy-source-server-side-encryption'
    : 'x-amz-server-side-encryption'
  return store.encryption.parseRequest(ctx.headers, { prefix })
}

export function notify(server: { notifications: NotificationDispatcher } | undefined, event: {
  bucket: string
  eventName: string
  key: string
  size?: number
  etag?: string
  versionId?: string
}): void {
  server?.notifications?.dispatch(event)
}
