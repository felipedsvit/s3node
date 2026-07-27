import { pipeline } from 'node:stream/promises'
import { S3Error } from './errors.js'
import {
  collectBody,
  baseHeaders,
  evaluatePreconditions,
  httpDate,
  isoDate,
  parseRange,
  sendEmpty,
  sendError,
  sendXml,
  userMetadata,
} from './http.js'
import { CHECKSUM_ALGORITHMS } from './util/hash.js'
import { toKeyBuffer } from './util/bytes.js'
import { childText, childrenNamed, document, escapeXml, parseXml, text } from './xml.js'

const MAX_DELETE_KEYS = 1000
const OWNER_ID = 's3node'
const OWNER_DISPLAY_NAME = 's3node'

const ownerXml = `<Owner>${text('ID', OWNER_ID)}${text('DisplayName', OWNER_DISPLAY_NAME)}</Owner>`

function maybeEncode(value, encodingType) {
  return encodingType === 'url' ? encodeURIComponent(value) : value
}

function integerParam(query, name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = query.get(name)
  if (raw === undefined || raw === '') return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new S3Error('InvalidArgument', `Invalid value for ${name}`)
  }
  return parsed
}

/* --------------------------- integrity input --------------------------- */

/**
 * Collects everything the request declared about body integrity: Content-MD5,
 * the literal payload SHA-256 (when not streaming/unsigned) and the
 * `x-amz-checksum-*` family, which modern SDKs send by default as a trailer
 * (docs/plan.md section 4.2).
 */
function integrityOptions(ctx) {
  const headers = ctx.headers
  const payloadHash = ctx.auth.payloadHash
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

function checksumHeaders(checksums) {
  const headers = {}
  for (const [algorithm, value] of Object.entries(checksums ?? {})) {
    headers[`x-amz-checksum-${algorithm}`] = value
  }
  return headers
}

/* ------------------------------- service ------------------------------- */

export function listBuckets(ctx, res, { store }) {
  const buckets = store.listBuckets()
    .map((bucket) => `<Bucket>${text('Name', bucket.name)}${text('CreationDate', isoDate(bucket.createdAt))}</Bucket>`)
    .join('')
  sendXml(ctx, res, 200, document('ListAllMyBucketsResult', `${ownerXml}<Buckets>${buckets}</Buckets>`))
}

/* -------------------------------- bucket ------------------------------- */

export async function createBucket(ctx, res, { store }) {
  await collectBody(ctx.bodyStreams).catch(() => Buffer.alloc(0))
  store.createBucket(ctx.bucket)
  sendEmpty(ctx, res, 200, { Location: `/${ctx.bucket}` })
}

export async function deleteBucket(ctx, res, { store }) {
  await store.deleteBucket(ctx.bucket)
  sendEmpty(ctx, res, 204)
}

export function headBucket(ctx, res, { store }) {
  store.requireBucket(ctx.bucket)
  sendEmpty(ctx, res, 200, { 'x-amz-bucket-region': store.region })
}

export function getBucketLocation(ctx, res, { store }) {
  store.requireBucket(ctx.bucket)
  const constraint = store.region === 'us-east-1' ? '' : escapeXml(store.region)
  sendXml(ctx, res, 200, document('LocationConstraint', constraint))
}

export function getBucketVersioning(ctx, res, { store }) {
  store.requireBucket(ctx.bucket)
  sendXml(ctx, res, 200, document('VersioningConfiguration', ''))
}

function listCommon(ctx, store) {
  const query = ctx.query
  const prefix = query.get('prefix') ?? ''
  const delimiter = query.get('delimiter') ?? ''
  const encodingType = query.get('encoding-type') ?? ''
  const maxKeys = integerParam(query, 'max-keys', 1000, { min: 0, max: 1000 })
  return { prefix, delimiter, encodingType, maxKeys }
}

export function listObjectsV2(ctx, res, { store }) {
  const { prefix, delimiter, encodingType, maxKeys } = listCommon(ctx, store)
  const continuationToken = ctx.query.get('continuation-token')
  const startAfter = ctx.query.get('start-after') ?? ''
  const fetchOwner = ctx.query.get('fetch-owner') === 'true'

  const cursor = continuationToken ? Buffer.from(continuationToken, 'base64') : null
  const result = store.listObjects(ctx.bucket, { prefix, delimiter, maxKeys, startAfter, cursor })

  const contents = result.contents.map((record) => (
    `<Contents>${
      text('Key', maybeEncode(record.key.toString('utf8'), encodingType))
    }${text('LastModified', isoDate(record.lastModified))
    }${text('ETag', record.etag)
    }${text('Size', record.size)
    }${text('StorageClass', 'STANDARD')
    }${fetchOwner ? ownerXml : ''}</Contents>`
  )).join('')

  const commonPrefixes = result.commonPrefixes
    .map((value) => `<CommonPrefixes>${text('Prefix', maybeEncode(value, encodingType))}</CommonPrefixes>`)
    .join('')

  const body =
    text('Name', ctx.bucket) +
    text('Prefix', maybeEncode(prefix, encodingType)) +
    (delimiter ? text('Delimiter', maybeEncode(delimiter, encodingType)) : '') +
    text('MaxKeys', maxKeys) +
    text('KeyCount', result.contents.length + result.commonPrefixes.length) +
    text('IsTruncated', String(result.truncated)) +
    (continuationToken ? text('ContinuationToken', continuationToken) : '') +
    (result.truncated && result.nextCursor
      ? text('NextContinuationToken', Buffer.from(result.nextCursor).toString('base64'))
      : '') +
    (startAfter ? text('StartAfter', maybeEncode(startAfter, encodingType)) : '') +
    (encodingType ? text('EncodingType', encodingType) : '') +
    contents + commonPrefixes

  sendXml(ctx, res, 200, document('ListBucketResult', body))
}

export function listObjectsV1(ctx, res, { store }) {
  const { prefix, delimiter, encodingType, maxKeys } = listCommon(ctx, store)
  const marker = ctx.query.get('marker') ?? ''
  const result = store.listObjects(ctx.bucket, { prefix, delimiter, maxKeys, startAfter: marker })

  const contents = result.contents.map((record) => (
    `<Contents>${
      text('Key', maybeEncode(record.key.toString('utf8'), encodingType))
    }${text('LastModified', isoDate(record.lastModified))
    }${text('ETag', record.etag)
    }${text('Size', record.size)
    }${text('StorageClass', 'STANDARD')}${ownerXml}</Contents>`
  )).join('')

  const commonPrefixes = result.commonPrefixes
    .map((value) => `<CommonPrefixes>${text('Prefix', maybeEncode(value, encodingType))}</CommonPrefixes>`)
    .join('')

  // V1 pagination is by last key returned, not by an opaque cursor, so the
  // marker is whichever of the two result lists ends highest in byte order.
  const candidates = [
    result.contents.at(-1)?.key.toString('utf8'),
    result.commonPrefixes.at(-1),
  ].filter((value) => value !== undefined)
  const lastKey = candidates.sort((a, b) => Buffer.compare(toKeyBuffer(a), toKeyBuffer(b))).at(-1)

  const body =
    text('Name', ctx.bucket) +
    text('Prefix', maybeEncode(prefix, encodingType)) +
    text('Marker', maybeEncode(marker, encodingType)) +
    (delimiter ? text('Delimiter', maybeEncode(delimiter, encodingType)) : '') +
    text('MaxKeys', maxKeys) +
    text('IsTruncated', String(result.truncated)) +
    (result.truncated && lastKey ? text('NextMarker', maybeEncode(lastKey, encodingType)) : '') +
    (encodingType ? text('EncodingType', encodingType) : '') +
    contents + commonPrefixes

  sendXml(ctx, res, 200, document('ListBucketResult', body))
}

export async function deleteObjects(ctx, res, { store }) {
  store.requireBucket(ctx.bucket)
  const body = await collectBody(ctx.bodyStreams)
  const root = parseXml(body)
  if (root.name !== 'Delete') throw new S3Error('MalformedXML', 'Expected a Delete element')

  const quiet = childText(root, 'Quiet') === 'true'
  const entries = childrenNamed(root, 'Object')
  if (entries.length === 0) throw new S3Error('MalformedXML', 'No objects specified')
  if (entries.length > MAX_DELETE_KEYS) {
    throw new S3Error('MalformedXML', `A maximum of ${MAX_DELETE_KEYS} keys may be deleted in one request`)
  }

  const deleted = []
  const errors = []
  for (const entry of entries) {
    const key = childText(entry, 'Key')
    if (!key) {
      errors.push({ key: '', code: 'MalformedXML', message: 'Missing Key' })
      continue
    }
    try {
      await store.deleteObject(ctx.bucket, key)
      deleted.push(key)
    } catch (err) {
      const s3 = err instanceof S3Error ? err : new S3Error('InternalError', err.message)
      errors.push({ key, code: s3.code, message: s3.message })
    }
  }

  const payload =
    (quiet ? '' : deleted.map((key) => `<Deleted>${text('Key', key)}</Deleted>`).join('')) +
    errors.map((entry) =>
      `<Error>${text('Key', entry.key)}${text('Code', entry.code)}${text('Message', entry.message)}</Error>`
    ).join('')

  sendXml(ctx, res, 200, document('DeleteResult', payload))
}

/* -------------------------------- object ------------------------------- */

export async function putObject(ctx, res, { store }) {
  const result = await store.putObject({
    bucket: ctx.bucket,
    key: ctx.key,
    body: ctx.bodyStreams,
    contentType: ctx.headers['content-type'],
    metadata: userMetadata(ctx.headers),
    ...integrityOptions(ctx),
  })
  sendEmpty(ctx, res, 200, { ETag: result.etag, ...checksumHeaders(result.checksums) })
}

export async function copyObject(ctx, res, { store }) {
  const raw = String(ctx.headers['x-amz-copy-source'])
  const withoutQuery = raw.split('?')[0]
  const normalized = withoutQuery.startsWith('/') ? withoutQuery.slice(1) : withoutQuery
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

  const directive = String(ctx.headers['x-amz-metadata-directive'] ?? 'COPY').toUpperCase()
  const result = await store.copyObject({
    sourceBucket,
    sourceKey,
    bucket: ctx.bucket,
    key: ctx.key,
    replaceMetadata: directive === 'REPLACE',
    metadata: userMetadata(ctx.headers),
    contentType: ctx.headers['content-type'],
  })

  sendXml(ctx, res, 200, document('CopyObjectResult',
    text('LastModified', isoDate(result.lastModified)) + text('ETag', result.etag)))
}

function objectResponseHeaders(ctx, record) {
  const headers = {
    ...baseHeaders(ctx),
    'Content-Type': record.contentType ?? 'application/octet-stream',
    ETag: record.etag,
    'Last-Modified': httpDate(record.lastModified),
    'Accept-Ranges': 'bytes',
    ...checksumHeaders(record.checksums),
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
  const record = store.getObject(ctx.bucket, ctx.key)

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
  await pipeline(store.createObjectStream(record, start, end), res)
}

export function headObject(ctx, res, { store }) {
  const record = store.getObject(ctx.bucket, ctx.key)
  if (evaluatePreconditions(ctx.headers, record) === 'not-modified') {
    sendEmpty(ctx, res, 304, { ETag: record.etag })
    return
  }
  res.writeHead(200, { ...objectResponseHeaders(ctx, record), 'Content-Length': record.size })
  res.end()
}

export async function deleteObject(ctx, res, { store }) {
  await store.deleteObject(ctx.bucket, ctx.key)
  // S3 deletes are idempotent: a missing key still reports success.
  sendEmpty(ctx, res, 204)
}

/* ------------------------------ multipart ------------------------------ */

export async function createMultipartUpload(ctx, res, { store }) {
  const uploadId = store.createMultipartUpload({
    bucket: ctx.bucket,
    key: ctx.key,
    contentType: ctx.headers['content-type'],
    metadata: userMetadata(ctx.headers),
  })
  sendXml(ctx, res, 200, document('InitiateMultipartUploadResult',
    text('Bucket', ctx.bucket) + text('Key', ctx.key) + text('UploadId', uploadId)))
}

export async function uploadPart(ctx, res, { store }) {
  const partNumber = Number.parseInt(ctx.query.get('partNumber'), 10)
  const result = await store.uploadPart({
    bucket: ctx.bucket,
    key: ctx.key,
    uploadId: ctx.query.get('uploadId'),
    partNumber,
    body: ctx.bodyStreams,
    ...integrityOptions(ctx),
  })
  sendEmpty(ctx, res, 200, { ETag: result.etag })
}

export async function completeMultipartUpload(ctx, res, { store }) {
  const uploadId = ctx.query.get('uploadId')
  const body = await collectBody(ctx.bodyStreams)
  const root = parseXml(body)
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

  const location = `http://${ctx.headers.host ?? 'localhost'}/${ctx.bucket}/${encodeURIComponent(ctx.key)}`
  sendXml(ctx, res, 200, document('CompleteMultipartUploadResult',
    text('Location', location) + text('Bucket', ctx.bucket) +
    text('Key', ctx.key) + text('ETag', result.etag)))
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

export { sendError, toKeyBuffer }
