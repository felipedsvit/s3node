import type { ServerResponse } from 'node:http'
import { pipeline } from 'node:stream/promises'
import { S3Error } from '../errors.js'
import { EncryptionContext, encryptionResponseHeaders } from '../features/encryption.js'
import {
  legalHoldXml,
  lockFromHeaders,
  lockResponseHeaders,
  parseLegalHoldXml,
  parseRetentionXml,
  retentionXml,
} from '../features/objectlock.js'
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
  type RequestContext,
} from '../http.js'
import { document, text } from '../xml.js'
import { checksumHeaders, integrityOptions, notify, parseCopySource, sseRequest, versionHeaders } from './shared.js'
import type { S3NodeServer } from '../server.js'
import type { ObjectStore } from '../storage/store.js'

function requestedVersionId(ctx: RequestContext): string | null {
  const versionId = ctx.query.get('versionId')
  return versionId || null
}

export async function putObject(ctx: RequestContext, res: ServerResponse, { store, server }: { store: ObjectStore; server: S3NodeServer }): Promise<void> {
  const result = await store.putObject({
    bucket: ctx.bucket,
    key: ctx.key,
    body: ctx.bodyStreams,
    contentType: ctx.headers['content-type'] as string | undefined,
    metadata: userMetadata(ctx.headers as Record<string, string | string[] | undefined>),
    tags: parseTaggingHeader(ctx.headers['x-amz-tagging'] as string | undefined),
    encryptionRequest: sseRequest(ctx, store),
    lock: lockFromHeaders(ctx.headers as Record<string, string | string[] | undefined>),
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

export async function copyObject(ctx: RequestContext, res: ServerResponse, { store, server }: { store: ObjectStore; server: S3NodeServer }): Promise<void> {
  const { bucket: sourceBucket, key: sourceKey, versionId: sourceVersionId } =
    parseCopySource(ctx.headers['x-amz-copy-source'])

  const metadataDirective = String(ctx.headers['x-amz-metadata-directive'] ?? 'COPY').toUpperCase()
  const taggingDirective = String(ctx.headers['x-amz-tagging-directive'] ?? 'COPY').toUpperCase()

  const result = await store.copyObject({
    sourceBucket,
    sourceKey,
    sourceVersionId,
    bucket: ctx.bucket,
    key: ctx.key,
    replaceMetadata: metadataDirective === 'REPLACE',
    metadata: userMetadata(ctx.headers as Record<string, string | string[] | undefined>),
    contentType: ctx.headers['content-type'] as string | undefined,
    replaceTags: taggingDirective === 'REPLACE',
    tags: parseTaggingHeader(ctx.headers['x-amz-tagging'] as string | undefined),
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

/** The fields of an object record that shape its response headers. */
interface DescribableObject {
  contentType?: string | undefined
  etag: string
  lastModified: Date
  checksums?: Record<string, string>
  encryption?: EncryptionContext | null
  versionId?: string
  tags?: Record<string, string>
  metadata?: Record<string, string>
  retentionMode?: string | null
  retainUntil?: Date | null
  legalHold?: boolean
}

function objectResponseHeaders(ctx: RequestContext, record: DescribableObject): Record<string, string | number> {
  const headers: Record<string, string | number> = {
    ...baseHeaders(ctx),
    'Content-Type': record.contentType ?? 'application/octet-stream',
    ETag: record.etag,
    'Last-Modified': httpDate(record.lastModified),
    'Accept-Ranges': 'bytes',
    ...checksumHeaders(record.checksums ?? {}),
    ...encryptionResponseHeaders(record.encryption),
    ...lockResponseHeaders({
      retentionMode: record.retentionMode ?? null,
      retainUntil: record.retainUntil ?? null,
      legalHold: record.legalHold ?? false,
    }),
  }
  if (record.versionId && record.versionId !== 'null') headers['x-amz-version-id'] = record.versionId
  if (Object.keys(record.tags ?? {}).length) {
    headers['x-amz-tagging-count'] = String(Object.keys(record.tags!).length)
  }
  for (const [name, value] of Object.entries(record.metadata ?? {})) {
    headers[`x-amz-meta-${name}`] = value
  }
  const overrides: Record<string, string> = {
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

export async function getObject(ctx: RequestContext, res: ServerResponse, { store }: { store: ObjectStore }): Promise<void> {
  const record = store.getObject(ctx.bucket, ctx.key, requestedVersionId(ctx))
  const encryptionKey = store.resolveEncryptionKey(record, sseRequest(ctx, store))

  if (evaluatePreconditions(ctx.headers as Record<string, string | string[] | undefined>, record) === 'not-modified') {
    sendEmpty(ctx, res, 304, { ETag: record.etag, 'Last-Modified': httpDate(record.lastModified) })
    return
  }

  const range = parseRange(ctx.headers.range as string | undefined, record.size)
  const start = range ? range.start : 0
  const end = range ? range.end : record.size - 1
  const length = record.size === 0 ? 0 : end - start + 1

  const headers: Record<string, string | number> = { ...objectResponseHeaders(ctx, record), 'Content-Length': length }
  if (range) {
    headers['Content-Range'] = `bytes ${start}-${end}/${record.size}`
    for (const name of Object.keys(headers)) {
      if (name.startsWith('x-amz-checksum-')) delete headers[name]
    }
  }

  res.writeHead(range ? 206 : 200, headers as Record<string, string | number>)
  if (length === 0) {
    res.end()
    return
  }
  await pipeline(store.createObjectStream(record, start, end, { encryptionKey }), res)
}

export function headObject(ctx: RequestContext, res: ServerResponse, { store }: { store: ObjectStore }): void {
  const record = store.getObject(ctx.bucket, ctx.key, requestedVersionId(ctx))
  store.resolveEncryptionKey(record, sseRequest(ctx, store))
  if (evaluatePreconditions(ctx.headers as Record<string, string | string[] | undefined>, record) === 'not-modified') {
    sendEmpty(ctx, res, 304, { ETag: record.etag })
    return
  }
  res.writeHead(200, { ...objectResponseHeaders(ctx, record), 'Content-Length': record.size })
  res.end()
}

export async function deleteObject(ctx: RequestContext, res: ServerResponse, { store, server }: { store: ObjectStore; server: S3NodeServer }): Promise<void> {
  const result = await store.deleteObject(ctx.bucket, ctx.key, requestedVersionId(ctx),
    { bypassGovernance: bypassGovernance(ctx) })

  if (result.deleted) {
    notify(server, {
      bucket: ctx.bucket,
      eventName: result.deleteMarker ? 'ObjectRemoved:DeleteMarkerCreated' : 'ObjectRemoved:Delete',
      key: ctx.key, size: 0, versionId: result.versionId,
    })
  }

  const headers: Record<string, string> = {}
  if (result.versionId && result.versionId !== 'null') headers['x-amz-version-id'] = result.versionId
  if (result.deleteMarker) headers['x-amz-delete-marker'] = 'true'
  sendEmpty(ctx, res, 204, headers)
}

export function getObjectTagging(ctx: RequestContext, res: ServerResponse, { store }: { store: ObjectStore }): void {
  const versionId = requestedVersionId(ctx)
  const tags = store.getObjectTags(ctx.bucket, ctx.key, versionId)
  sendXml(ctx, res, 200, taggingXml(tags), versionId ? { 'x-amz-version-id': versionId } : {})
}

export async function putObjectTagging(ctx: RequestContext, res: ServerResponse, { store }: { store: ObjectStore }): Promise<void> {
  const tags = parseTaggingXml(await collectBody(ctx.bodyStreams))
  const versionId = store.setObjectTags(ctx.bucket, ctx.key, requestedVersionId(ctx), tags)
  sendEmpty(ctx, res, 200, versionId !== 'null' ? { 'x-amz-version-id': versionId } : {})
}

export function deleteObjectTagging(ctx: RequestContext, res: ServerResponse, { store }: { store: ObjectStore }): void {
  const versionId = store.setObjectTags(ctx.bucket, ctx.key, requestedVersionId(ctx), {})
  sendEmpty(ctx, res, 204, versionId !== 'null' ? { 'x-amz-version-id': versionId } : {})
}

function bypassGovernance(ctx: RequestContext): boolean {
  return String(ctx.headers['x-amz-bypass-governance-retention'] ?? '').toLowerCase() === 'true'
}

export function getObjectRetention(ctx: RequestContext, res: ServerResponse, { store }: { store: ObjectStore }): void {
  const lock = store.getObjectLock(ctx.bucket, ctx.key, requestedVersionId(ctx))
  sendXml(ctx, res, 200, retentionXml(lock))
}

export async function putObjectRetention(ctx: RequestContext, res: ServerResponse, { store }: { store: ObjectStore }): Promise<void> {
  const retention = parseRetentionXml(await collectBody(ctx.bodyStreams))
  const versionId = store.setRetention(ctx.bucket, ctx.key, requestedVersionId(ctx), retention,
    { bypassGovernance: bypassGovernance(ctx) })
  sendEmpty(ctx, res, 200, versionId !== 'null' ? { 'x-amz-version-id': versionId } : {})
}

export function getObjectLegalHold(ctx: RequestContext, res: ServerResponse, { store }: { store: ObjectStore }): void {
  const lock = store.getObjectLock(ctx.bucket, ctx.key, requestedVersionId(ctx))
  sendXml(ctx, res, 200, legalHoldXml(lock.legalHold))
}

export async function putObjectLegalHold(ctx: RequestContext, res: ServerResponse, { store }: { store: ObjectStore }): Promise<void> {
  const held = parseLegalHoldXml(await collectBody(ctx.bodyStreams))
  const versionId = store.setLegalHold(ctx.bucket, ctx.key, requestedVersionId(ctx), held)
  sendEmpty(ctx, res, 200, versionId !== 'null' ? { 'x-amz-version-id': versionId } : {})
}
