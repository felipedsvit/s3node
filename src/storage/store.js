import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { S3Error } from '../errors.js'
import { CHECKSUM_ALGORITHMS, multipartEtag } from '../util/hash.js'
import { toKeyBuffer } from '../util/bytes.js'
import { BlobStore } from './blobs.js'
import { MetadataStore } from './metadata.js'

export const MAX_KEY_BYTES = 1024
export const DEFAULT_MIN_PART_SIZE = 5 * 1024 * 1024
export const MAX_PARTS = 10_000

const BUCKET_NAME_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/

export function validateBucketName(name) {
  if (!BUCKET_NAME_RE.test(name) || name.includes('..') || IPV4_RE.test(name)) {
    throw new S3Error('InvalidBucketName')
  }
  return name
}

export function validateKey(key) {
  const buf = toKeyBuffer(key)
  if (buf.length === 0) throw new S3Error('InvalidArgument', 'Object key must not be empty')
  if (buf.length > MAX_KEY_BYTES) throw new S3Error('KeyTooLongError')
  return key
}

function checksumMismatch(algorithm, expected, actual) {
  return new S3Error(
    'InvalidRequest',
    `Value for x-amz-checksum-${algorithm} header is invalid: expected ${expected}, computed ${actual}`,
  )
}

/**
 * Storage facade: metadata in SQLite, bytes in the content-addressed blob
 * store. All ordering guarantees between the two live here.
 */
export class ObjectStore {
  constructor({ dataDir, region = 'us-east-1', minPartSize = DEFAULT_MIN_PART_SIZE }) {
    this.dataDir = dataDir
    this.region = region
    this.minPartSize = minPartSize
    this.blobs = new BlobStore(dataDir)
    this.metadata = null
  }

  static async open(options) {
    const store = new ObjectStore(options)
    await mkdir(options.dataDir, { recursive: true })
    await store.blobs.init()
    store.metadata = new MetadataStore(join(options.dataDir, 'metadata.sqlite'))
    return store
  }

  close() {
    this.metadata?.close()
  }

  requireBucket(name) {
    const bucket = this.metadata.getBucket(name)
    if (!bucket) throw new S3Error('NoSuchBucket', undefined, { bucketName: name })
    return bucket
  }

  /* ---------------------------- buckets ---------------------------- */

  createBucket(name) {
    validateBucketName(name)
    if (this.metadata.getBucket(name)) throw new S3Error('BucketAlreadyOwnedByYou')
    this.metadata.createBucket(name, this.region)
  }

  async deleteBucket(name) {
    this.requireBucket(name)
    if (!this.metadata.isBucketEmpty(name)) throw new S3Error('BucketNotEmpty')
    const orphans = this.metadata.blobsInBucket(name)
    this.metadata.deleteBucket(name)
    await this.blobs.removeMany(orphans)
  }

  listBuckets() {
    return this.metadata.listBuckets()
  }

  /* ---------------------------- objects ---------------------------- */

  /**
   * Streams the body to a blob, validates every integrity header the client
   * sent, and only then commits metadata.
   */
  async putObject({
    bucket, key, body, contentType, metadata = {},
    contentMd5 = null, expectedSha256 = null, checksumAlgorithm = null, expectedChecksum = null,
    trailerProvider = null,
  }) {
    this.requireBucket(bucket)
    validateKey(key)

    const algorithms = ['md5']
    if (expectedSha256) algorithms.push('sha256')
    if (checksumAlgorithm) algorithms.push(checksumAlgorithm)

    const { blobId, size, hasher } = await this.blobs.write(body, { algorithms })

    try {
      const md5 = hasher.digest('md5', 'hex')

      if (contentMd5 && hasher.digest('md5', 'base64') !== contentMd5) {
        throw new S3Error('BadDigest')
      }
      if (expectedSha256 && hasher.digest('sha256', 'hex') !== expectedSha256) {
        throw new S3Error('XAmzContentSHA256Mismatch')
      }

      // A checksum may arrive as a header (known up front) or as a trailer at
      // the end of an aws-chunked body (docs/plan.md 4.2).
      const checksums = {}
      if (checksumAlgorithm) {
        const computed = hasher.digest(checksumAlgorithm, 'base64')
        const declared = expectedChecksum ?? trailerProvider?.(`x-amz-checksum-${checksumAlgorithm}`) ?? null
        if (declared && declared !== computed) {
          throw checksumMismatch(checksumAlgorithm, declared, computed)
        }
        checksums[checksumAlgorithm] = computed
      }

      const etag = `"${md5}"`
      const lastModified = new Date()
      const previous = this.metadata.getObject(bucket, key)

      this.metadata.putObject({
        bucket, key, size, etag, contentType, lastModified,
        blobId, parts: null, metadata, checksums,
      })

      // Metadata is committed; the superseded blob is now unreferenced.
      if (previous) await this._releaseObjectBlobs(previous)

      return { etag, size, lastModified, checksums }
    } catch (err) {
      await this.blobs.remove(blobId)
      throw err
    }
  }

  getObject(bucket, key) {
    this.requireBucket(bucket)
    const record = this.metadata.getObject(bucket, key)
    if (!record) throw new S3Error('NoSuchKey', undefined, { key: String(key) })
    return record
  }

  /** Readable over [start, end] inclusive, spanning a manifest when needed. */
  createObjectStream(record, start = 0, end = record.size - 1) {
    if (record.size === 0) return this.blobs.createRangeStream([], 0, -1)
    if (record.parts) return this.blobs.createRangeStream(record.parts, start, end)
    return this.blobs.createReadStream(record.blobId, { start, end })
  }

  async deleteObject(bucket, key) {
    this.requireBucket(bucket)
    const record = this.metadata.getObject(bucket, key)
    if (!record) return false
    // Drop the reference first: a crash then leaves an orphan blob, never a
    // metadata row pointing at missing data.
    this.metadata.deleteObject(bucket, key)
    await this._releaseObjectBlobs(record)
    return true
  }

  async copyObject({ sourceBucket, sourceKey, bucket, key, metadata, contentType, replaceMetadata }) {
    const source = this.getObject(sourceBucket, sourceKey)
    this.requireBucket(bucket)
    validateKey(key)

    const stream = this.createObjectStream(source)
    const { blobId, size, hasher } = await this.blobs.write(stream, { algorithms: ['md5'] })
    try {
      const etag = `"${hasher.digest('md5', 'hex')}"`
      const lastModified = new Date()
      const previous = this.metadata.getObject(bucket, key)
      this.metadata.putObject({
        bucket, key, size, etag, lastModified,
        contentType: replaceMetadata ? contentType : source.contentType,
        blobId, parts: null,
        metadata: replaceMetadata ? metadata : source.metadata,
        checksums: {},
      })
      if (previous) await this._releaseObjectBlobs(previous)
      return { etag, lastModified, size }
    } catch (err) {
      await this.blobs.remove(blobId)
      throw err
    }
  }

  listObjects(bucket, options) {
    this.requireBucket(bucket)
    return this.metadata.listObjects(bucket, options)
  }

  async _releaseObjectBlobs(record) {
    const ids = []
    if (record.blobId) ids.push(record.blobId)
    if (record.parts) for (const part of record.parts) ids.push(part.blobId)
    await this.blobs.removeMany(ids)
  }

  /* -------------------------- multipart ---------------------------- */

  createMultipartUpload({ bucket, key, contentType, metadata = {} }) {
    this.requireBucket(bucket)
    validateKey(key)
    const uploadId = randomUUID().replaceAll('-', '')
    this.metadata.createUpload({ uploadId, bucket, key, contentType, metadata })
    return uploadId
  }

  requireUpload(uploadId, bucket, key) {
    const upload = this.metadata.getUpload(uploadId)
    if (!upload || upload.bucket !== bucket || Buffer.compare(upload.key, toKeyBuffer(key)) !== 0) {
      throw new S3Error('NoSuchUpload')
    }
    return upload
  }

  async uploadPart({ bucket, key, uploadId, partNumber, body, contentMd5, expectedSha256, checksumAlgorithm, expectedChecksum, trailerProvider }) {
    this.requireUpload(uploadId, bucket, key)
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > MAX_PARTS) {
      throw new S3Error('InvalidArgument', `Part number must be an integer between 1 and ${MAX_PARTS}`)
    }

    const algorithms = ['md5']
    if (expectedSha256) algorithms.push('sha256')
    if (checksumAlgorithm) algorithms.push(checksumAlgorithm)

    const { blobId, size, hasher } = await this.blobs.write(body, { algorithms })
    try {
      if (contentMd5 && hasher.digest('md5', 'base64') !== contentMd5) throw new S3Error('BadDigest')
      if (expectedSha256 && hasher.digest('sha256', 'hex') !== expectedSha256) {
        throw new S3Error('XAmzContentSHA256Mismatch')
      }
      if (checksumAlgorithm) {
        const computed = hasher.digest(checksumAlgorithm, 'base64')
        const declared = expectedChecksum ?? trailerProvider?.(`x-amz-checksum-${checksumAlgorithm}`) ?? null
        if (declared && declared !== computed) throw checksumMismatch(checksumAlgorithm, declared, computed)
      }

      const etag = `"${hasher.digest('md5', 'hex')}"`
      const previous = this.metadata.getPart(uploadId, partNumber)
      this.metadata.putPart({ uploadId, partNumber, size, etag, blobId })
      // Re-uploading a part number replaces it; the old blob is now garbage.
      if (previous) await this.blobs.remove(previous.blobId)
      return { etag, size }
    } catch (err) {
      await this.blobs.remove(blobId)
      throw err
    }
  }

  listParts(bucket, key, uploadId, options) {
    this.requireUpload(uploadId, bucket, key)
    return this.metadata.listParts(uploadId, options)
  }

  listMultipartUploads(bucket, maxUploads) {
    this.requireBucket(bucket)
    return this.metadata.listUploads(bucket, maxUploads)
  }

  async completeMultipartUpload({ bucket, key, uploadId, requestedParts }) {
    const upload = this.requireUpload(uploadId, bucket, key)
    if (!requestedParts.length) throw new S3Error('InvalidRequest', 'You must specify at least one part')

    const stored = new Map(this.metadata.allParts(uploadId).map((part) => [part.partNumber, part]))
    const manifest = []
    let previousNumber = 0

    for (const [index, requested] of requestedParts.entries()) {
      if (requested.partNumber <= previousNumber) throw new S3Error('InvalidPartOrder')
      previousNumber = requested.partNumber

      const part = stored.get(requested.partNumber)
      if (!part) {
        throw new S3Error('InvalidPart', `Part ${requested.partNumber} was not uploaded`)
      }
      const normalize = (etag) => etag.replaceAll('"', '').replace(/^&quot;|&quot;$/g, '')
      if (normalize(part.etag) !== normalize(requested.etag)) {
        throw new S3Error('InvalidPart', `ETag mismatch for part ${requested.partNumber}`)
      }
      if (index < requestedParts.length - 1 && part.size < this.minPartSize) {
        throw new S3Error('EntityTooSmall',
          `Part ${requested.partNumber} is ${part.size} bytes; the minimum is ${this.minPartSize}`)
      }
      manifest.push({ partNumber: part.partNumber, size: part.size, etag: part.etag, blobId: part.blobId })
    }

    const size = manifest.reduce((total, part) => total + part.size, 0)
    const etag = `"${multipartEtag(manifest.map((part) => part.etag.replaceAll('"', '')))}"`
    const lastModified = new Date()
    const previous = this.metadata.getObject(bucket, key)

    this.metadata.putObject({
      bucket, key, size, etag, lastModified,
      contentType: upload.contentType,
      blobId: null, parts: manifest,
      metadata: upload.metadata, checksums: {},
    })
    this.metadata.deleteUpload(uploadId)

    // Parts not referenced by the manifest are now unreachable, as is whatever
    // object previously occupied the key.
    const kept = new Set(manifest.map((part) => part.blobId))
    const discarded = [...stored.values()].map((part) => part.blobId).filter((id) => !kept.has(id))
    await this.blobs.removeMany(discarded)
    if (previous) await this._releaseObjectBlobs(previous)

    return { etag, size, lastModified }
  }

  async abortMultipartUpload({ bucket, key, uploadId }) {
    this.requireUpload(uploadId, bucket, key)
    const parts = this.metadata.allParts(uploadId)
    this.metadata.deleteUpload(uploadId)
    await this.blobs.removeMany(parts.map((part) => part.blobId))
  }
}

export { CHECKSUM_ALGORITHMS }
