import type { ServerResponse } from 'node:http'
import { S3Error } from '../errors.js'
import { encryptionResponseHeaders } from '../features/encryption.js'
import { parseTaggingHeader } from '../features/tagging.js'
import { collectRequestBody, isoDate, sendEmpty, sendXml, userMetadata, type RequestContext } from '../http.js'
import { childText, childrenNamed, document, parseXml, text } from '../xml.js'
import {
  checksumHeaders, integerParam, integrityOptions, notify, ownerXml, parseCopySource, sseRequest,
  versionHeaders,
} from './shared.js'
import type { ObjectStore } from '../storage/store.js'
import type { S3NodeServer } from '../server.js'
import { objectArn } from '../features/policy.js'
import { lockFromHeaders } from '../features/objectlock.js'

export function createMultipartUpload(ctx: RequestContext, res: ServerResponse, { store }: { store: ObjectStore }): void {
  const { uploadId, encryption } = store.createMultipartUpload({
    bucket: ctx.bucket,
    key: ctx.key,
    contentType: ctx.headers['content-type'] as string | undefined,
    metadata: userMetadata(ctx.headers as Record<string, string | string[] | undefined>),
    tags: parseTaggingHeader(ctx.headers['x-amz-tagging'] as string | undefined),
    encryptionRequest: sseRequest(ctx, store),
    lock: lockFromHeaders(ctx.headers as Record<string, string | string[] | undefined>),
  })
  sendXml(ctx, res, 200, document('InitiateMultipartUploadResult',
    text('Bucket', ctx.bucket) + text('Key', ctx.key) + text('UploadId', uploadId)),
  encryptionResponseHeaders(encryption))
}

export async function uploadPart(ctx: RequestContext, res: ServerResponse, { store }: { store: ObjectStore }): Promise<void> {
  const partNumber = Number(ctx.query.get('partNumber'))
  const result = await store.uploadPart({
    bucket: ctx.bucket,
    key: ctx.key,
    uploadId: ctx.query.get('uploadId')!,
    partNumber,
    body: ctx.bodyStreams,
    encryptionRequest: sseRequest(ctx, store),
    ...integrityOptions(ctx),
  })
  sendEmpty(ctx, res, 200, { ETag: result.etag, ...encryptionResponseHeaders(result.encryption) })
}

/**
 * `x-amz-copy-source-range` uses the same `bytes=first-last` syntax as Range,
 * but S3 does not accept the suffix or open-ended forms here, so both bounds
 * are required.
 */
function parseCopySourceRange(header: string | string[] | undefined): { start: number; end: number } | null {
  if (header === undefined) return null
  const match = /^bytes=(\d+)-(\d+)$/.exec(String(header).trim())
  if (!match) {
    throw new S3Error('InvalidArgument', 'x-amz-copy-source-range must be of the form bytes=first-last')
  }
  const start = Number(match[1])
  const end = Number(match[2])
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
    throw new S3Error('InvalidArgument', 'x-amz-copy-source-range bounds are too large')
  }
  return { start, end }
}

export async function uploadPartCopy(ctx: RequestContext, res: ServerResponse, { store, server }: { store: ObjectStore; server: S3NodeServer }): Promise<void> {
  const source = parseCopySource(ctx.headers['x-amz-copy-source'])
  server.authorize(ctx, 's3:GetObject', objectArn(source.bucket, source.key), {}, source.bucket)
  const result = await store.uploadPartCopy({
    bucket: ctx.bucket,
    key: ctx.key,
    uploadId: ctx.query.get('uploadId')!,
    partNumber: Number(ctx.query.get('partNumber')),
    sourceBucket: source.bucket,
    sourceKey: source.key,
    sourceVersionId: source.versionId,
    sourceRange: parseCopySourceRange(ctx.headers['x-amz-copy-source-range']),
    sourceEncryptionRequest: sseRequest(ctx, store, { copySource: true }),
    encryptionRequest: sseRequest(ctx, store),
  })

  sendXml(ctx, res, 200, document('CopyPartResult',
    text('LastModified', isoDate(result.lastModified)) + text('ETag', result.etag)),
  {
    ...encryptionResponseHeaders(result.encryption),
    ...(result.sourceVersionId ? { 'x-amz-copy-source-version-id': result.sourceVersionId } : {}),
  })
}

export async function completeMultipartUpload(ctx: RequestContext, res: ServerResponse, { store, server }: { store: ObjectStore; server: S3NodeServer }): Promise<void> {
  const uploadId = ctx.query.get('uploadId')!
  const root = parseXml(await collectRequestBody(ctx))
  if (root.name !== 'CompleteMultipartUpload') {
    throw new S3Error('MalformedXML', 'Expected a CompleteMultipartUpload element')
  }

  const requestedParts = childrenNamed(root, 'Part').map((part) => {
    const rawPartNumber = childText(part, 'PartNumber') ?? ''
    const partNumber = /^\d+$/.test(rawPartNumber) ? Number(rawPartNumber) : Number.NaN
    const etag = childText(part, 'ETag')
    if (!Number.isInteger(partNumber) || !etag) {
      throw new S3Error('MalformedXML', 'Each Part requires PartNumber and ETag')
    }
    return { partNumber, etag }
  })

  const result = await store.completeMultipartUpload({
    bucket: ctx.bucket, key: ctx.key, uploadId, requestedParts,
  })

  notify(server, {
    bucket: ctx.bucket, eventName: 'ObjectCreated:CompleteMultipartUpload', key: ctx.key,
    size: result.size, etag: result.etag, versionId: result.versionId,
  })

  const location = `http://${ctx.headers.host ?? 'localhost'}/${ctx.bucket}/${encodeURIComponent(ctx.key)}`
  sendXml(ctx, res, 200, document('CompleteMultipartUploadResult',
    text('Location', location) + text('Bucket', ctx.bucket) +
    text('Key', ctx.key) + text('ETag', result.etag)),
  { ...versionHeaders(result), ...encryptionResponseHeaders(result.encryption) })
}

export async function abortMultipartUpload(ctx: RequestContext, res: ServerResponse, { store }: { store: ObjectStore }): Promise<void> {
  await store.abortMultipartUpload({
    bucket: ctx.bucket, key: ctx.key, uploadId: ctx.query.get('uploadId')!,
  })
  sendEmpty(ctx, res, 204)
}

export function listParts(ctx: RequestContext, res: ServerResponse, { store }: { store: ObjectStore }): void {
  const uploadId = ctx.query.get('uploadId')!
  store.requireUpload(uploadId, ctx.bucket, ctx.key)
  const partNumberMarker = integerParam(ctx.query, 'part-number-marker', 0)
  const maxParts = integerParam(ctx.query, 'max-parts', 1000, { min: 0, max: 1000 })
  const fetched = maxParts === 0 ? [] : store.listParts(ctx.bucket, ctx.key, uploadId, {
    partNumberMarker, maxParts: maxParts + 1,
  })
  const truncated = fetched.length > maxParts
  const parts = truncated ? fetched.slice(0, maxParts) : fetched

  const nextMarker = truncated ? parts[parts.length - 1].partNumber : undefined
  const body =
    text('Bucket', ctx.bucket) + text('Key', ctx.key) + text('UploadId', uploadId) +
    text('PartNumberMarker', partNumberMarker) + text('MaxParts', maxParts) +
    text('IsTruncated', String(truncated)) +
    (truncated ? text('NextPartNumberMarker', nextMarker) : '') +
    text('StorageClass', 'STANDARD') + ownerXml +
    parts.map((part) =>
      `<Part>${text('PartNumber', part.partNumber)}${text('LastModified', isoDate(part.uploadedAt!))
      }${text('ETag', part.etag)}${text('Size', part.size)}</Part>`
    ).join('')

  sendXml(ctx, res, 200, document('ListPartsResult', body))
}

export function listMultipartUploads(ctx: RequestContext, res: ServerResponse, { store }: { store: ObjectStore }): void {
  store.requireBucket(ctx.bucket)
  const maxUploads = integerParam(ctx.query, 'max-uploads', 1000, { min: 0, max: 1000 })
  const keyMarker = ctx.query.get('key-marker') ?? ''
  const uploadIdMarker = ctx.query.get('upload-id-marker') ?? null
  const fetched = maxUploads === 0
    ? []
    : store.listMultipartUploads(ctx.bucket, maxUploads + 1, keyMarker, uploadIdMarker)
  const truncated = fetched.length > maxUploads
  const uploads = truncated ? fetched.slice(0, maxUploads) : fetched
  const last = truncated ? uploads[uploads.length - 1] : null
  const body =
    text('Bucket', ctx.bucket) + text('MaxUploads', maxUploads) +
    text('IsTruncated', String(truncated)) +
    (truncated && last ? text('NextKeyMarker', last.key.toString('utf8')) : '') +
    (truncated && last ? text('NextUploadIdMarker', last.uploadId) : '') +
    uploads.map((upload) =>
      `<Upload>${text('Key', upload.key.toString('utf8'))}${text('UploadId', upload.uploadId)
      }${ownerXml}${text('StorageClass', 'STANDARD')}${text('Initiated', isoDate(upload.initiatedAt))}</Upload>`
    ).join('')
  sendXml(ctx, res, 200, document('ListMultipartUploadsResult', body))
}

export { checksumHeaders }
