import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { S3Error } from '../errors.js'
import { EncryptionManager, blockAlignedOffset } from '../features/encryption.js'
import { CHECKSUM_ALGORITHMS, multipartEtag } from '../util/hash.js'
import { toKeyBuffer } from '../util/bytes.js'
import { BlobStore } from './blobs.js'
import { MetadataStore, NULL_VERSION } from './metadata.js'

export const MAX_KEY_BYTES = 1024
export const DEFAULT_MIN_PART_SIZE = 5 * 1024 * 1024
export const MAX_PARTS = 10_000
export const READ_HIGH_WATER_MARK = 1024 * 1024

/** Bucket subresources stored in `bucket_config`. */
export const CONFIG_NAMES = ['versioning', 'policy', 'cors', 'lifecycle', 'tagging', 'notification']

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

function newVersionId() {
  return randomUUID().replaceAll('-', '')
}

function checksumMismatch(algorithm, expected, actual) {
  return new S3Error(
    'InvalidRequest',
    `Value for x-amz-checksum-${algorithm} header is invalid: expected ${expected}, computed ${actual}`,
  )
}

/** Runs a stream chain and exposes the result as a single readable. */
function chain(...streams) {
  if (streams.length === 1) return streams[0]
  const output = new PassThrough({ highWaterMark: READ_HIGH_WATER_MARK })
  pipeline(...streams, output).catch((err) => output.destroy(err))
  return output
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
    this.encryption = null
  }

  static async open(options) {
    const store = new ObjectStore(options)
    await mkdir(options.dataDir, { recursive: true })
    await store.blobs.init()
    store.metadata = new MetadataStore(join(options.dataDir, 'metadata.sqlite'))
    store.encryption = await EncryptionManager.load(
      join(options.dataDir, 'master.key'), options.encryptionMasterKey ?? null)
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

  /* ------------------------ bucket subresources -------------------- */

  getBucketConfig(bucket, name) {
    this.requireBucket(bucket)
    return this.metadata.getConfig(bucket, name)
  }

  putBucketConfig(bucket, name, value) {
    this.requireBucket(bucket)
    this.metadata.putConfig(bucket, name, value)
  }

  deleteBucketConfig(bucket, name) {
    this.requireBucket(bucket)
    this.metadata.deleteConfig(bucket, name)
  }

  /** 'Unset' until the bucket has been configured; then 'Enabled' or 'Suspended'. */
  bucketVersioning(bucket) {
    return this.metadata.getConfig(bucket, 'versioning')?.status ?? 'Unset'
  }

  /* ---------------------------- objects ---------------------------- */

  /**
   * Streams the body to a blob, validates every integrity header the client
   * sent, and only then commits metadata.
   */
  async putObject({
    bucket, key, body, contentType, metadata = {}, tags = {},
    contentMd5 = null, expectedSha256 = null, checksumAlgorithm = null, expectedChecksum = null,
    trailerProvider = null, encryptionRequest = null,
  }) {
    this.requireBucket(bucket)
    validateKey(key)

    const algorithms = ['md5']
    if (expectedSha256) algorithms.push('sha256')
    if (checksumAlgorithm) algorithms.push(checksumAlgorithm)

    let encryption = null
    let transforms = []
    if (encryptionRequest) {
      const created = this.encryption.create(encryptionRequest)
      encryption = created.context
      transforms = [this.encryption.createEncryptStream(created.key, encryption, 0)]
    }

    const { blobId, size, hasher } = await this.blobs.write(body, { algorithms, transforms })

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
      const versioning = this.bucketVersioning(bucket)
      const versionId = versioning === 'Enabled' ? newVersionId() : NULL_VERSION
      // Only an unversioned write overwrites a row; with versioning enabled the
      // previous version keeps both its row and its blob.
      const replaced = versionId === NULL_VERSION
        ? this.metadata.getObject(bucket, key, NULL_VERSION)
        : null

      this.metadata.transaction(() => {
        this.metadata.clearLatest(bucket, key)
        this.metadata.putObject({
          bucket, key, versionId, isLatest: true, isDeleteMarker: false,
          size, etag, contentType, lastModified,
          blobId, parts: null, metadata, checksums, tags, encryption,
        })
      })

      // Metadata is committed; the superseded blob is now unreferenced.
      if (replaced) await this._releaseObjectBlobs(replaced)

      return { etag, size, lastModified, checksums, versionId, versioned: versioning === 'Enabled', encryption }
    } catch (err) {
      await this.blobs.remove(blobId)
      throw err
    }
  }

  getObject(bucket, key, versionId = null) {
    this.requireBucket(bucket)
    const record = this.metadata.getObject(bucket, key, versionId)
    if (!record) {
      throw new S3Error(versionId ? 'NoSuchVersion' : 'NoSuchKey', undefined, { key: String(key) })
    }
    if (record.isDeleteMarker) {
      // A delete marker addressed directly is a 405; reached as the current
      // version it reads as a plain 404.
      throw new S3Error(versionId ? 'MethodNotAllowed' : 'NoSuchKey', undefined, {
        headers: { 'x-amz-delete-marker': 'true', 'x-amz-version-id': record.versionId },
      })
    }
    return record
  }

  /** Resolves the data key for a stored object, enforcing SSE-C key presentation. */
  resolveEncryptionKey(record, encryptionRequest) {
    if (!record.encryption) {
      if (encryptionRequest?.mode === 'SSE-C') {
        throw new S3Error('InvalidRequest', 'The object was not stored with SSE-C')
      }
      return null
    }
    return this.encryption.resolveKey(record.encryption, encryptionRequest)
  }

  /** Readable over [start, end] inclusive, spanning a manifest when needed. */
  createObjectStream(record, start = 0, end = record.size - 1, { encryptionKey = null } = {}) {
    if (record.size === 0 || end < start) return Readable.from([])

    const context = record.encryption
    if (!context) {
      return record.parts
        ? this.blobs.createRangeStream(record.parts, start, end)
        : this.blobs.createReadStream(record.blobId, { start, end })
    }

    const manager = this.encryption
    if (!record.parts) {
      // CTR seeking needs the ciphertext read to begin on a block boundary.
      const aligned = blockAlignedOffset(start)
      return chain(
        this.blobs.createReadStream(record.blobId, { start: aligned, end }),
        ...manager.createDecryptStreams(encryptionKey, context, start, 0),
      )
    }

    const blobs = this.blobs
    const parts = record.parts
    async function* generate() {
      let offset = 0
      for (const part of parts) {
        const partStart = offset
        const partEnd = offset + part.size - 1
        offset += part.size
        if (partEnd < start) continue
        if (partStart > end) break
        const from = Math.max(start - partStart, 0)
        const to = Math.min(end - partStart, part.size - 1)
        if (to < from) continue
        yield* chain(
          blobs.createReadStream(part.blobId, { start: blockAlignedOffset(from), end: to }),
          ...manager.createDecryptStreams(encryptionKey, context, from, part.partNumber),
        )
      }
    }
    return Readable.from(generate(), { highWaterMark: READ_HIGH_WATER_MARK })
  }

  /**
   * Removes a version, or writes a delete marker when the bucket is versioned.
   * Returns what happened so the handler can set the response headers.
   */
  async deleteObject(bucket, key, versionId = null) {
    this.requireBucket(bucket)
    const versioning = this.bucketVersioning(bucket)

    if (versionId) {
      const record = this.metadata.getObject(bucket, key, versionId)
      if (!record) return { deleted: false }
      this.metadata.transaction(() => {
        this.metadata.deleteVersion(bucket, key, versionId)
        if (record.isLatest) this.metadata.promoteLatest(bucket, key)
      })
      await this._releaseObjectBlobs(record)
      return { deleted: true, versionId, deleteMarker: record.isDeleteMarker }
    }

    if (versioning === 'Enabled' || versioning === 'Suspended') {
      const markerVersion = versioning === 'Enabled' ? newVersionId() : NULL_VERSION
      const replaced = markerVersion === NULL_VERSION
        ? this.metadata.getObject(bucket, key, NULL_VERSION)
        : null
      this.metadata.transaction(() => {
        this.metadata.clearLatest(bucket, key)
        this.metadata.putObject({
          bucket, key, versionId: markerVersion, isLatest: true, isDeleteMarker: true,
          size: 0, etag: '', lastModified: new Date(), blobId: null,
        })
      })
      if (replaced) await this._releaseObjectBlobs(replaced)
      return { deleted: true, versionId: markerVersion, deleteMarker: true }
    }

    const record = this.metadata.getObject(bucket, key)
    if (!record) return { deleted: false }
    // Drop the reference first: a crash then leaves an orphan blob, never a
    // metadata row pointing at missing data.
    this.metadata.deleteVersion(bucket, key, record.versionId)
    await this._releaseObjectBlobs(record)
    return { deleted: true }
  }

  async copyObject({
    sourceBucket, sourceKey, sourceVersionId = null, bucket, key,
    metadata, contentType, replaceMetadata, tags, replaceTags,
    sourceEncryptionRequest = null, encryptionRequest = null,
  }) {
    const source = this.getObject(sourceBucket, sourceKey, sourceVersionId)
    this.requireBucket(bucket)
    validateKey(key)

    const sourceKeyMaterial = this.resolveEncryptionKey(source, sourceEncryptionRequest)
    const plaintext = this.createObjectStream(source, 0, source.size - 1,
      { encryptionKey: sourceKeyMaterial })

    let encryption = null
    let transforms = []
    if (encryptionRequest) {
      const created = this.encryption.create(encryptionRequest)
      encryption = created.context
      transforms = [this.encryption.createEncryptStream(created.key, encryption, 0)]
    }

    const { blobId, size, hasher } = await this.blobs.write(plaintext, { algorithms: ['md5'], transforms })
    try {
      const etag = `"${hasher.digest('md5', 'hex')}"`
      const lastModified = new Date()
      const versioning = this.bucketVersioning(bucket)
      const versionId = versioning === 'Enabled' ? newVersionId() : NULL_VERSION
      const replaced = versionId === NULL_VERSION
        ? this.metadata.getObject(bucket, key, NULL_VERSION)
        : null

      this.metadata.transaction(() => {
        this.metadata.clearLatest(bucket, key)
        this.metadata.putObject({
          bucket, key, versionId, isLatest: true, isDeleteMarker: false,
          size, etag, lastModified,
          contentType: replaceMetadata ? contentType : source.contentType,
          blobId, parts: null,
          metadata: replaceMetadata ? metadata : source.metadata,
          checksums: {},
          tags: replaceTags ? tags : source.tags,
          encryption,
        })
      })
      if (replaced) await this._releaseObjectBlobs(replaced)
      return { etag, lastModified, size, versionId, versioned: versioning === 'Enabled', encryption }
    } catch (err) {
      await this.blobs.remove(blobId)
      throw err
    }
  }

  listObjects(bucket, options) {
    this.requireBucket(bucket)
    return this.metadata.listObjects(bucket, options)
  }

  listVersions(bucket, options) {
    this.requireBucket(bucket)
    return this.metadata.listVersions(bucket, options)
  }

  /* ---------------------------- tagging ---------------------------- */

  getObjectTags(bucket, key, versionId = null) {
    return this.getObject(bucket, key, versionId).tags ?? {}
  }

  setObjectTags(bucket, key, versionId, tags) {
    const record = this.getObject(bucket, key, versionId)
    this.metadata.setTags(bucket, key, record.versionId, tags)
    return record.versionId
  }

  async _releaseObjectBlobs(record) {
    const ids = []
    if (record.blobId) ids.push(record.blobId)
    if (record.parts) for (const part of record.parts) ids.push(part.blobId)
    await this.blobs.removeMany(ids)
  }

  /* -------------------------- multipart ---------------------------- */

  createMultipartUpload({ bucket, key, contentType, metadata = {}, tags = {}, encryptionRequest = null }) {
    this.requireBucket(bucket)
    validateKey(key)
    const uploadId = randomUUID().replaceAll('-', '')
    // Fixing the encryption context up front is what lets every part share one
    // key while still getting a non-overlapping counter window.
    const encryption = encryptionRequest ? this.encryption.create(encryptionRequest).context : null
    this.metadata.createUpload({ uploadId, bucket, key, contentType, metadata, tags, encryption })
    return { uploadId, encryption }
  }

  requireUpload(uploadId, bucket, key) {
    const upload = this.metadata.getUpload(uploadId)
    if (!upload || upload.bucket !== bucket || Buffer.compare(upload.key, toKeyBuffer(key)) !== 0) {
      throw new S3Error('NoSuchUpload')
    }
    return upload
  }

  async uploadPart({
    bucket, key, uploadId, partNumber, body, contentMd5, expectedSha256,
    checksumAlgorithm, expectedChecksum, trailerProvider, encryptionRequest = null,
  }) {
    const upload = this.requireUpload(uploadId, bucket, key)
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > MAX_PARTS) {
      throw new S3Error('InvalidArgument', `Part number must be an integer between 1 and ${MAX_PARTS}`)
    }

    const algorithms = ['md5']
    if (expectedSha256) algorithms.push('sha256')
    if (checksumAlgorithm) algorithms.push(checksumAlgorithm)

    let transforms = []
    if (upload.encryption) {
      const dataKey = this.encryption.resolveKey(upload.encryption, encryptionRequest)
      transforms = [this.encryption.createEncryptStream(dataKey, upload.encryption, partNumber)]
    }

    const { blobId, size, hasher } = await this.blobs.write(body, { algorithms, transforms })
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
      return { etag, size, encryption: upload.encryption }
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
    const versioning = this.bucketVersioning(bucket)
    const versionId = versioning === 'Enabled' ? newVersionId() : NULL_VERSION
    const replaced = versionId === NULL_VERSION
      ? this.metadata.getObject(bucket, key, NULL_VERSION)
      : null

    this.metadata.transaction(() => {
      this.metadata.clearLatest(bucket, key)
      this.metadata.putObject({
        bucket, key, versionId, isLatest: true, isDeleteMarker: false,
        size, etag, lastModified,
        contentType: upload.contentType,
        blobId: null, parts: manifest,
        metadata: upload.metadata, checksums: {},
        tags: upload.tags, encryption: upload.encryption,
      })
      this.metadata.deleteUpload(uploadId)
    })

    // Parts not referenced by the manifest are now unreachable, as is whatever
    // object previously occupied the key.
    const kept = new Set(manifest.map((part) => part.blobId))
    const discarded = [...stored.values()].map((part) => part.blobId).filter((id) => !kept.has(id))
    await this.blobs.removeMany(discarded)
    if (replaced) await this._releaseObjectBlobs(replaced)

    return { etag, size, lastModified, versionId, versioned: versioning === 'Enabled', encryption: upload.encryption }
  }

  async abortMultipartUpload({ bucket, key, uploadId }) {
    this.requireUpload(uploadId, bucket, key)
    const parts = this.metadata.allParts(uploadId)
    this.metadata.deleteUpload(uploadId)
    await this.blobs.removeMany(parts.map((part) => part.blobId))
  }
}

export { CHECKSUM_ALGORITHMS, NULL_VERSION }
