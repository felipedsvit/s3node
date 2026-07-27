import { S3Error } from '../errors.js'
import { encryptionResponseHeaders } from '../features/encryption.js'
import { parseTaggingHeader } from '../features/tagging.js'
import { collectBody, isoDate, sendEmpty, sendXml, userMetadata } from '../http.js'
import { childText, childrenNamed, document, parseXml, text } from '../xml.js'
import {
  checksumHeaders, integerParam, integrityOptions, notify, ownerXml, sseRequest, versionHeaders,
} from './shared.js'

export function createMultipartUpload(ctx, res, { store }) {
  const { uploadId, encryption } = store.createMultipartUpload({
    bucket: ctx.bucket,
    key: ctx.key,
    contentType: ctx.headers['content-type'],
    metadata: userMetadata(ctx.headers),
    tags: parseTaggingHeader(ctx.headers['x-amz-tagging']),
    encryptionRequest: sseRequest(ctx, store),
  })
  sendXml(ctx, res, 200, document('InitiateMultipartUploadResult',
    text('Bucket', ctx.bucket) + text('Key', ctx.key) + text('UploadId', uploadId)),
  encryptionResponseHeaders(encryption))
}

export async function uploadPart(ctx, res, { store }) {
  const partNumber = Number.parseInt(ctx.query.get('partNumber'), 10)
  const result = await store.uploadPart({
    bucket: ctx.bucket,
    key: ctx.key,
    uploadId: ctx.query.get('uploadId'),
    partNumber,
    body: ctx.bodyStreams,
    encryptionRequest: sseRequest(ctx, store),
    ...integrityOptions(ctx),
  })
  sendEmpty(ctx, res, 200, { ETag: result.etag, ...encryptionResponseHeaders(result.encryption) })
}

export async function completeMultipartUpload(ctx, res, { store, server }) {
  const uploadId = ctx.query.get('uploadId')
  const root = parseXml(await collectBody(ctx.bodyStreams))
  if (root.name !== 'CompleteMultipartUpload') {
    throw new S3Error('MalformedXML', 'Expected a CompleteMultipartUpload element')
  }

  const requestedParts = childrenNamed(root, 'Part').map((part) => {
    const partNumber = Number.parseInt(childText(part, 'PartNumber') ?? '', 10)
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

export async function abortMultipartUpload(ctx, res, { store }) {
  await store.abortMultipartUpload({
    bucket: ctx.bucket, key: ctx.key, uploadId: ctx.query.get('uploadId'),
  })
  sendEmpty(ctx, res, 204)
}

export function listParts(ctx, res, { store }) {
  const uploadId = ctx.query.get('uploadId')
  const partNumberMarker = integerParam(ctx.query, 'part-number-marker', 0)
  const maxParts = integerParam(ctx.query, 'max-parts', 1000, { min: 0, max: 1000 })
  const parts = store.listParts(ctx.bucket, ctx.key, uploadId, { partNumberMarker, maxParts })

  const body =
    text('Bucket', ctx.bucket) + text('Key', ctx.key) + text('UploadId', uploadId) +
    text('PartNumberMarker', partNumberMarker) + text('MaxParts', maxParts) +
    text('IsTruncated', String(parts.length === maxParts)) +
    text('StorageClass', 'STANDARD') + ownerXml +
    parts.map((part) =>
      `<Part>${text('PartNumber', part.partNumber)}${text('LastModified', isoDate(part.uploadedAt))
      }${text('ETag', part.etag)}${text('Size', part.size)}</Part>`
    ).join('')

  sendXml(ctx, res, 200, document('ListPartsResult', body))
}

export function listMultipartUploads(ctx, res, { store }) {
  const maxUploads = integerParam(ctx.query, 'max-uploads', 1000, { min: 0, max: 1000 })
  const uploads = store.listMultipartUploads(ctx.bucket, maxUploads)
  const body =
    text('Bucket', ctx.bucket) + text('MaxUploads', maxUploads) +
    text('IsTruncated', String(uploads.length === maxUploads)) +
    uploads.map((upload) =>
      `<Upload>${text('Key', upload.key.toString('utf8'))}${text('UploadId', upload.uploadId)
      }${ownerXml}${text('StorageClass', 'STANDARD')}${text('Initiated', isoDate(upload.initiatedAt))}</Upload>`
    ).join('')
  sendXml(ctx, res, 200, document('ListMultipartUploadsResult', body))
}

export { checksumHeaders }
