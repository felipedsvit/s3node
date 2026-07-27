import { randomBytes } from 'node:crypto'
import { Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { S3Error } from './errors.js'
import { errorDocument } from './xml.js'

export const MAX_XML_BODY_BYTES = 1024 * 1024

export function requestId() {
  return randomBytes(8).toString('hex').toUpperCase()
}

export function hostId() {
  return randomBytes(24).toString('base64')
}

/** RFC 1123, as required for Last-Modified and Date headers. */
export function httpDate(date) {
  return date.toUTCString()
}

/** ISO 8601 with milliseconds, as required inside S3 XML payloads. */
export function isoDate(date) {
  return date.toISOString()
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

export function parseQueryPairs(rawQuery) {
  if (!rawQuery) return []
  return rawQuery.split('&').filter(Boolean).map((pair) => {
    const eq = pair.indexOf('=')
    return eq === -1
      ? [safeDecode(pair), '']
      : [safeDecode(pair.slice(0, eq)), safeDecode(pair.slice(eq + 1))]
  })
}

/**
 * Resolve bucket and key.
 *
 * Virtual-host style is only attempted when a base domain is configured. SigV4
 * signs the Host header, so a proxy that rewrites Host invalidates every
 * signature — see docs/plan.md section 4.6.
 */
function resolveTarget(rawPath, headers, virtualHostDomain) {
  const decodedPath = safeDecode(rawPath)
  if (virtualHostDomain) {
    const host = String(headers.host ?? '').split(':')[0].toLowerCase()
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

export function createContext(req, { virtualHostDomain = null } = {}) {
  const rawUrl = req.url ?? '/'
  const queryStart = rawUrl.indexOf('?')
  const rawPath = queryStart === -1 ? rawUrl : rawUrl.slice(0, queryStart)
  const rawQuery = queryStart === -1 ? '' : rawUrl.slice(queryStart + 1)
  const queryPairs = parseQueryPairs(rawQuery)

  const query = new Map()
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

/** User metadata carried on `x-amz-meta-*` headers. */
export function userMetadata(headers) {
  const metadata = {}
  for (const [name, value] of Object.entries(headers)) {
    if (name.startsWith('x-amz-meta-')) metadata[name.slice('x-amz-meta-'.length)] = String(value)
  }
  return metadata
}

export async function collectBody(sources, maxBytes = MAX_XML_BODY_BYTES) {
  const chunks = []
  let total = 0
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      total += chunk.length
      if (total > maxBytes) {
        callback(new S3Error('MalformedXML', 'Request body exceeds the maximum accepted size'))
        return
      }
      chunks.push(chunk)
      callback()
    },
  })
  await pipeline(...sources, sink)
  return Buffer.concat(chunks)
}

export function baseHeaders(ctx) {
  return {
    'x-amz-request-id': ctx.requestId,
    'x-amz-id-2': ctx.hostId,
    Date: httpDate(new Date()),
    Server: 'S3Node',
  }
}

export function sendXml(ctx, res, status, body, extraHeaders = {}) {
  const payload = Buffer.from(body, 'utf8')
  res.writeHead(status, {
    ...baseHeaders(ctx),
    'Content-Type': 'application/xml',
    'Content-Length': payload.length,
    ...extraHeaders,
  })
  res.end(ctx.method === 'HEAD' ? undefined : payload)
}

export function sendEmpty(ctx, res, status, extraHeaders = {}) {
  res.writeHead(status, { ...baseHeaders(ctx), 'Content-Length': 0, ...extraHeaders })
  res.end()
}

export function sendError(ctx, res, error) {
  const s3 = error instanceof S3Error ? error : new S3Error('InternalError', error?.message)
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
  const headers = {
    'x-amz-request-id': ctx?.requestId ?? requestId(),
    'x-amz-id-2': ctx?.hostId ?? hostId(),
    Date: httpDate(new Date()),
    Server: 'S3Node',
    'Content-Type': 'application/xml',
    'Content-Length': payload.length,
  }
  if (s3.detail?.contentRange) headers['Content-Range'] = s3.detail.contentRange
  res.writeHead(s3.statusCode, headers)
  // A 304 or a HEAD response must not carry a body.
  res.end(ctx?.method === 'HEAD' || s3.statusCode === 304 ? undefined : payload)
  return s3
}

/** Parse a single-range `Range: bytes=` header. Returns null when absent. */
export function parseRange(header, size) {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim())
  if (!match) return null
  const [, rawStart, rawEnd] = match
  if (rawStart === '' && rawEnd === '') return null

  let start
  let end
  if (rawStart === '') {
    const suffix = Number.parseInt(rawEnd, 10)
    if (suffix <= 0) throw new S3Error('InvalidRange', undefined, { contentRange: `bytes */${size}` })
    start = Math.max(size - suffix, 0)
    end = size - 1
  } else {
    start = Number.parseInt(rawStart, 10)
    end = rawEnd === '' ? size - 1 : Number.parseInt(rawEnd, 10)
    if (end >= size) end = size - 1
  }
  if (start >= size || start > end) {
    throw new S3Error('InvalidRange', undefined, { contentRange: `bytes */${size}` })
  }
  return { start, end }
}

function etagMatches(candidate, etag) {
  const normalize = (value) => value.trim().replace(/^W\//, '').replaceAll('"', '')
  return candidate.split(',').some((entry) => {
    const trimmed = entry.trim()
    return trimmed === '*' || normalize(trimmed) === normalize(etag)
  })
}

/**
 * RFC 7232 precondition evaluation. Order matters: If-Match wins over
 * If-Unmodified-Since, If-None-Match over If-Modified-Since.
 */
export function evaluatePreconditions(headers, { etag, lastModified }) {
  const modifiedSeconds = Math.floor(lastModified.getTime() / 1000)

  if (headers['if-match'] !== undefined) {
    if (!etagMatches(headers['if-match'], etag)) throw new S3Error('PreconditionFailed')
  } else if (headers['if-unmodified-since'] !== undefined) {
    const since = Date.parse(headers['if-unmodified-since'])
    if (Number.isFinite(since) && modifiedSeconds > Math.floor(since / 1000)) {
      throw new S3Error('PreconditionFailed')
    }
  }

  if (headers['if-none-match'] !== undefined) {
    if (etagMatches(headers['if-none-match'], etag)) return 'not-modified'
  } else if (headers['if-modified-since'] !== undefined) {
    const since = Date.parse(headers['if-modified-since'])
    if (Number.isFinite(since) && modifiedSeconds <= Math.floor(since / 1000)) return 'not-modified'
  }

  return 'ok'
}
