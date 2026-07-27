import { pipeline } from 'node:stream/promises'
import { S3Error } from '../errors.js'
import { encryptionResponseHeaders } from '../features/encryption.js'
import { parseTaggingHeader, parseTaggingXml, taggingXml } from '../features/tagging.js'
import {
  baseHeaders,
  collectBody,
  evaluatePreconditions,
  httpDate,
  isoDate,
  parseRange,
  sendEmpty,
  sendXml,
  userMetadata,
} from '../http.js'
import { document, text } from '../xml.js'
import { checksumHeaders, integrityOptions, notify, sseRequest, versionHeaders } from './shared.js'

function requestedVersionId(ctx) {
  const versionId = ctx.query.get('versionId')
  return versionId || null
}

export async function putObject(ctx, res, { store, server }) {
  const result = await store.putObject({
    bucket: ctx.bucket,
    key: ctx.key,
    body: ctx.bodyStreams,
    contentType: ctx.headers['content-type'],
    metadata: userMetadata(ctx.headers),
    tags: parseTaggingHeader(ctx.headers['x-amz-tagging']),
    encryptionRequest: sseRequest(ctx, store),
    ...integrityOptions(ctx),
  })

  notify(server, {
    bucket: ctx.bucket, eventName: 'ObjectCreated:Put', key: ctx.key,
    size: result.size, etag: result.etag, versionId: result.versionId,
  })

  sendEmpty(ctx, res, 200, {
    ETag: result.etag,
    ...checksumHeaders(result.checksums),
    ...versionHeaders(result),
    ...encryptionResponseHeaders(result.encryption),
  })
}

export async function copyObject(ctx, res, { store, server }) {
  const raw = String(ctx.headers['x-amz-copy-source'])
  const [pathPart, queryPart] = raw.split('?')
  const normalized = pathPart.startsWith('/') ? pathPart.slice(1) : pathPart
  const slash = normalized.indexOf('/')
  if (slash === -1) throw new S3Error('InvalidArgument', 'Invalid x-amz-copy-source')

  let sourceBucket
  let sourceKey
  try {
    sourceBucket = decodeURIComponent(normalized.slice(0, slash))
    sourceKey = decodeURIComponent(normalized.slice(slash + 1))
  } catch {
    throw new S3Error('InvalidArgument', 'Invalid x-amz-copy-source encoding')
  }
  const sourceVersionId = queryPart
    ? new URLSearchParams(queryPart).get('versionId')
    : null

  const metadataDirective = String(ctx.headers['x-amz-metadata-directive'] ?? 'COPY').toUpperCase()
  const taggingDirective = String(ctx.headers['x-amz-tagging-directive'] ?? 'COPY').toUpperCase()

  const result = await store.copyObject({
    sourceBucket,
    sourceKey,
    sourceVersionId,
    bucket: ctx.bucket,
    key: ctx.key,
    replaceMetadata: metadataDirective === 'REPLACE',
    metadata: userMetadata(ctx.headers),
    contentType: ctx.headers['content-type'],
    replaceTags: taggingDirective === 'REPLACE',
    tags: parseTaggingHeader(ctx.headers['x-amz-tagging']),
    sourceEncryptionRequest: sseRequest(ctx, store, { copySource: true }),
    encryptionRequest: sseRequest(ctx, store),
  })

  notify(server, {
    bucket: ctx.bucket, eventName: 'ObjectCreated:Copy', key: ctx.key,
    size: result.size, etag: result.etag, versionId: result.versionId,
  })

  sendXml(ctx, res, 200, document('CopyObjectResult',
    text('LastModified', isoDate(result.lastModified)) + text('ETag', result.etag)),
  {
    ...versionHeaders(result),
    ...encryptionResponseHeaders(result.encryption),
    ...(sourceVersionId ? { 'x-amz-copy-source-version-id': sourceVersionId } : {}),
  })
}

function objectResponseHeaders(ctx, record) {
  const headers = {
    ...baseHeaders(ctx),
    'Content-Type': record.contentType ?? 'application/octet-stream',
    ETag: record.etag,
    'Last-Modified': httpDate(record.lastModified),
    'Accept-Ranges': 'bytes',
    ...checksumHeaders(record.checksums),
    ...encryptionResponseHeaders(record.encryption),
  }
  if (record.versionId && record.versionId !== 'null') headers['x-amz-version-id'] = record.versionId
  if (Object.keys(record.tags ?? {}).length) {
    headers['x-amz-tagging-count'] = String(Object.keys(record.tags).length)
  }
  for (const [name, value] of Object.entries(record.metadata ?? {})) {
    headers[`x-amz-meta-${name}`] = value
  }
  // Response header overrides for presigned download links.
  const overrides = {
    'response-content-type': 'Content-Type',
    'response-content-disposition': 'Content-Disposition',
    'response-content-encoding': 'Content-Encoding',
    'response-content-language': 'Content-Language',
    'response-cache-control': 'Cache-Control',
    'response-expires': 'Expires',
  }
  for (const [param, header] of Object.entries(overrides)) {
    const value = ctx.query.get(param)
    if (value !== undefined) headers[header] = value
  }
  return headers
}

export async function getObject(ctx, res, { store }) {
  const record = store.getObject(ctx.bucket, ctx.key, requestedVersionId(ctx))
  const encryptionKey = store.resolveEncryptionKey(record, sseRequest(ctx, store))

  if (evaluatePreconditions(ctx.headers, record) === 'not-modified') {
    sendEmpty(ctx, res, 304, { ETag: record.etag, 'Last-Modified': httpDate(record.lastModified) })
    return
  }

  const range = parseRange(ctx.headers.range, record.size)
  const start = range ? range.start : 0
  const end = range ? range.end : record.size - 1
  const length = record.size === 0 ? 0 : end - start + 1

  const headers = { ...objectResponseHeaders(ctx, record), 'Content-Length': length }
  if (range) {
    headers['Content-Range'] = `bytes ${start}-${end}/${record.size}`
    // The stored checksum covers the whole object, not the slice being sent.
    // Returning it makes SDK-side validation fail on every ranged read.
    for (const name of Object.keys(headers)) {
      if (name.startsWith('x-amz-checksum-')) delete headers[name]
    }
  }

  res.writeHead(range ? 206 : 200, headers)
  if (length === 0) {
    res.end()
    return
  }
  await pipeline(store.createObjectStream(record, start, end, { encryptionKey }), res)
}

export function headObject(ctx, res, { store }) {
  const record = store.getObject(ctx.bucket, ctx.key, requestedVersionId(ctx))
  store.resolveEncryptionKey(record, sseRequest(ctx, store))
  if (evaluatePreconditions(ctx.headers, record) === 'not-modified') {
    sendEmpty(ctx, res, 304, { ETag: record.etag })
    return
  }
  res.writeHead(200, { ...objectResponseHeaders(ctx, record), 'Content-Length': record.size })
  res.end()
}

export async function deleteObject(ctx, res, { store, server }) {
  const result = await store.deleteObject(ctx.bucket, ctx.key, requestedVersionId(ctx))

  if (result.deleted) {
    notify(server, {
      bucket: ctx.bucket,
      eventName: result.deleteMarker ? 'ObjectRemoved:DeleteMarkerCreated' : 'ObjectRemoved:Delete',
      key: ctx.key, size: 0, versionId: result.versionId,
    })
  }

  const headers = {}
  if (result.versionId && result.versionId !== 'null') headers['x-amz-version-id'] = result.versionId
  if (result.deleteMarker) headers['x-amz-delete-marker'] = 'true'
  // S3 deletes are idempotent: a missing key still reports success.
  sendEmpty(ctx, res, 204, headers)
}

/* ------------------------------ tagging ------------------------------- */

export function getObjectTagging(ctx, res, { store }) {
  const versionId = requestedVersionId(ctx)
  const tags = store.getObjectTags(ctx.bucket, ctx.key, versionId)
  sendXml(ctx, res, 200, taggingXml(tags), versionId ? { 'x-amz-version-id': versionId } : {})
}

export async function putObjectTagging(ctx, res, { store }) {
  const tags = parseTaggingXml(await collectBody(ctx.bodyStreams))
  const versionId = store.setObjectTags(ctx.bucket, ctx.key, requestedVersionId(ctx), tags)
  sendEmpty(ctx, res, 200, versionId !== 'null' ? { 'x-amz-version-id': versionId } : {})
}

export function deleteObjectTagging(ctx, res, { store }) {
  const versionId = store.setObjectTags(ctx.bucket, ctx.key, requestedVersionId(ctx), {})
  sendEmpty(ctx, res, 204, versionId !== 'null' ? { 'x-amz-version-id': versionId } : {})
}
