import { randomBytes } from 'node:crypto'
import { Writable, type WritableOptions } from 'node:stream'
import { pipeline as streamPipeline } from 'node:stream/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { S3Error } from './errors.js'
import { errorDocument } from './xml.js'

export const MAX_XML_BODY_BYTES = 1024 * 1024

export function requestId(): string {
  return randomBytes(8).toString('hex').toUpperCase()
}

export function hostId(): string {
  return randomBytes(24).toString('base64')
}

export function httpDate(date: Date): string {
  return date.toUTCString()
}

export function isoDate(date: Date): string {
  return date.toISOString()
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

export function parseQueryPairs(rawQuery: string): [string, string][] {
  if (!rawQuery) return []
  return rawQuery.split('&').filter(Boolean).map((pair) => {
    const eq = pair.indexOf('=')
    return eq === -1
      ? [safeDecode(pair), '']
      : [safeDecode(pair.slice(0, eq)), safeDecode(pair.slice(eq + 1))]
  })
}

function resolveTarget(rawPath: string, headers: IncomingMessage['headers'], virtualHostDomain: string | null): {
  bucket: string
  key: string
  style: 'virtual-host' | 'path'
} {
  const decodedPath = safeDecode(rawPath)
  if (virtualHostDomain) {
    const host = String(headers.host ?? '').split(':')[0]?.toLowerCase() ?? ''
    const suffix = `.${virtualHostDomain.toLowerCase()}`
    if (host.endsWith(suffix) && host.length > suffix.length) {
      return {
        bucket: host.slice(0, -suffix.length),
        key: decodedPath.length > 1 ? decodedPath.slice(1) : '',
        style: 'virtual-host',
      }
    }
  }
  const trimmed = decodedPath.startsWith('/') ? decodedPath.slice(1) : decodedPath
  if (trimmed === '') return { bucket: '', key: '', style: 'path' }
  const slash = trimmed.indexOf('/')
  return slash === -1
    ? { bucket: trimmed, key: '', style: 'path' }
    : { bucket: trimmed.slice(0, slash), key: trimmed.slice(slash + 1), style: 'path' }
}

/** Shape of `RequestContext.auth`, set once per request by `_authenticate`/`_handlePreflight`. */
export interface AuthInfo {
  anonymous: boolean
  /** Set when authentication is deferred to the handler (POST policy uploads). */
  deferred?: boolean
  accessKeyId?: string
  region?: string
  scope?: string
  amzDate?: string
  payloadHash?: string | null
  presigned?: boolean
  seedSignature?: string | null
  signingKey?: Buffer | null
  canonicalRequest?: string
  stringToSign?: string
}

export interface RequestContext {
  req: IncomingMessage
  method: string | undefined
  rawPath: string
  rawQuery: string
  queryPairs: [string, string][]
  query: Map<string, string>
  headers: IncomingMessage['headers']
  bucket: string
  key: string
  style: 'virtual-host' | 'path'
  requestId: string
  hostId: string
  bodyStreams: (IncomingMessage | import('node:stream').Transform)[]
  trailers: Record<string, string> | null
  auth?: AuthInfo | undefined
}

export function createContext(req: IncomingMessage, { virtualHostDomain = null }: { virtualHostDomain?: string | null } = {}): RequestContext {
  const rawUrl = req.url ?? '/'
  const queryStart = rawUrl.indexOf('?')
  const rawPath = queryStart === -1 ? rawUrl : rawUrl.slice(0, queryStart)
  const rawQuery = queryStart === -1 ? '' : rawUrl.slice(queryStart + 1)
  const queryPairs = parseQueryPairs(rawQuery)

  const query = new Map<string, string>()
  for (const [name, value] of queryPairs) if (!query.has(name)) query.set(name, value)

  const { bucket, key, style } = resolveTarget(rawPath, req.headers, virtualHostDomain)

  return {
    req,
    method: req.method,
    rawPath,
    rawQuery,
    queryPairs,
    query,
    headers: req.headers,
    bucket,
    key,
    style,
    requestId: requestId(),
    hostId: hostId(),
    bodyStreams: [req],
    trailers: null,
  }
}

export function userMetadata(headers: Record<string, string | string[] | undefined>, maxTotalBytes = 2048): Record<string, string> {
  const metadata: Record<string, string> = {}
  let total = 0
  for (const [name, value] of Object.entries(headers)) {
    if (name.startsWith('x-amz-meta-')) {
      const key = name.slice('x-amz-meta-'.length)
      const val = String(value)
      total += Buffer.byteLength(key, 'utf8') + Buffer.byteLength(val, 'utf8')
      if (total > maxTotalBytes) {
        throw new S3Error('InvalidArgument', 'Total user metadata size must not exceed 2 KB')
      }
      metadata[key] = val
    }
  }
  return metadata
}

export async function collectBody(sources: (import('node:stream').Readable | import('node:stream').Transform)[], maxBytes = MAX_XML_BODY_BYTES): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  const sink = new Writable({
    write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
      total += chunk.length
      if (total > maxBytes) {
        callback(new S3Error('MalformedXML', 'Request body exceeds the maximum accepted size'))
        return
      }
      chunks.push(chunk)
      callback()
    },
  })
  await (streamPipeline as (...args: unknown[]) => Promise<void>)(...sources, sink)
  return Buffer.concat(chunks)
}

export function baseHeaders(ctx: RequestContext): Record<string, string> {
  return {
    'x-amz-request-id': ctx.requestId,
    'x-amz-id-2': ctx.hostId,
    Date: httpDate(new Date()),
    Server: 'S3Node',
  }
}

export function sendXml(ctx: RequestContext, res: ServerResponse, status: number, body: string, extraHeaders: Record<string, string | number | undefined> = {}): void {
  const payload = Buffer.from(body, 'utf8')
  res.writeHead(status, {
    ...baseHeaders(ctx),
    'Content-Type': 'application/xml',
    'Content-Length': payload.length,
    ...extraHeaders,
  })
  res.end(ctx.method === 'HEAD' ? undefined : payload)
}

export function sendEmpty(ctx: RequestContext, res: ServerResponse, status: number, extraHeaders: Record<string, string | number | undefined> = {}): void {
  res.writeHead(status, { ...baseHeaders(ctx), 'Content-Length': 0, ...extraHeaders })
  res.end()
}

export function sendError(ctx: RequestContext | null, res: ServerResponse, error: unknown): S3Error {
  const s3 = error instanceof S3Error ? error : new S3Error('InternalError', (error as Error)?.message)
  if (res.headersSent) {
    res.destroy()
    return s3
  }
  const body = errorDocument({
    code: s3.code,
    message: s3.message,
    resource: ctx?.rawPath ?? '/',
    requestId: ctx?.requestId ?? requestId(),
    hostId: ctx?.hostId ?? hostId(),
  })
  const payload = Buffer.from(body, 'utf8')
  const headers: Record<string, string | number> = {
    'x-amz-request-id': ctx?.requestId ?? requestId(),
    'x-amz-id-2': ctx?.hostId ?? hostId(),
    Date: httpDate(new Date()),
    Server: 'S3Node',
    'Content-Type': 'application/xml',
    'Content-Length': payload.length,
  }
  if (s3.detail?.contentRange) headers['Content-Range'] = s3.detail.contentRange
  Object.assign(headers, s3.detail?.headers ?? {})
  res.writeHead(s3.statusCode, headers)
  res.end(ctx?.method === 'HEAD' || s3.statusCode === 304 ? undefined : payload)
  return s3
}

export interface ByteRange {
  start: number
  end: number
}

export function parseRange(header: string | undefined, size: number): ByteRange | null {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim())
  if (!match) return null
  const [, rawStart, rawEnd] = match

  let start: number
  let end: number
  if (rawStart === '') {
    const suffix = Number.parseInt(rawEnd!, 10)
    if (suffix <= 0) throw new S3Error('InvalidRange', undefined, { contentRange: `bytes */${size}` })
    start = Math.max(size - suffix, 0)
    end = size - 1
  } else {
    start = Number.parseInt(rawStart!, 10)
    end = rawEnd === '' ? size - 1 : Number.parseInt(rawEnd!, 10)
    if (end >= size) end = size - 1
  }
  if (start >= size || start > end) {
    throw new S3Error('InvalidRange', undefined, { contentRange: `bytes */${size}` })
  }
  return { start, end }
}

function etagMatches(candidate: string, etag: string): boolean {
  const normalize = (value: string) => value.trim().replace(/^W\//, '').replaceAll('"', '')
  return candidate.split(',').some((entry) => {
    const trimmed = entry.trim()
    return trimmed === '*' || normalize(trimmed) === normalize(etag)
  })
}

export type PreconditionResult = 'ok' | 'not-modified'

export function evaluatePreconditions(headers: Record<string, string | string[] | undefined>, { etag, lastModified }: { etag: string; lastModified: Date }): PreconditionResult {
  const modifiedSeconds = Math.floor(lastModified.getTime() / 1000)

  if (headers['if-match'] !== undefined) {
    if (!etagMatches(String(headers['if-match']), etag)) throw new S3Error('PreconditionFailed')
  } else if (headers['if-unmodified-since'] !== undefined) {
    const since = Date.parse(String(headers['if-unmodified-since']))
    if (Number.isFinite(since) && modifiedSeconds > Math.floor(since / 1000)) {
      throw new S3Error('PreconditionFailed')
    }
  }

  if (headers['if-none-match'] !== undefined) {
    if (etagMatches(String(headers['if-none-match']), etag)) return 'not-modified'
  } else if (headers['if-modified-since'] !== undefined) {
    const since = Date.parse(String(headers['if-modified-since']))
    if (Number.isFinite(since) && modifiedSeconds <= Math.floor(since / 1000)) return 'not-modified'
  }

  return 'ok'
}
