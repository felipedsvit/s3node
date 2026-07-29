import { Readable } from 'node:stream'
import { S3Error } from '../errors.js'
import { blockAlignedOffset, type EncryptionContext, type SseRequest } from '../features/encryption.js'
import {
  applyDefaultRetention,
  assertRetentionReplaceable,
  assertVersionDeletable,
  type LockState,
  type ObjectLockConfig,
  type Retention,
} from '../features/objectlock.js'
import { READ_HIGH_WATER_MARK } from './blobs.js'
import type { BucketService } from './buckets.js'
import {
  chainStreams,
  checksumMismatch,
  newVersionId,
  validateKey,
  type StoreContext,
} from './context.js'
import { NULL_VERSION, type ObjectRecord, type ListObjectsResult, type ListVersionsResult } from './metadata.js'
import { sliceParts } from './parts.js'
import type {
  CopyObjectInput,
  CopyObjectResult,
  DeleteObjectResult,
  ListObjectsOptions,
  ListVersionsOptions,
  PutObjectInput,
  PutObjectResult,
} from './types.js'

/** Whole-object reads and writes, versioning, ranged reads and object tags. */
export class ObjectService {
  constructor(
    private readonly ctx: StoreContext,
    private readonly buckets: BucketService,
  ) {}

  async putObject(input: PutObjectInput): Promise<PutObjectResult> {
    this.buckets.requireBucket(input.bucket)
    validateKey(input.key)

    const algorithms = ['md5']
    if (input.expectedSha256) algorithms.push('sha256')
    if (input.checksumAlgorithm) algorithms.push(input.checksumAlgorithm)

    let encryption: EncryptionContext | null = null
    let transforms: NodeJS.ReadWriteStream[] = []
    if (input.encryptionRequest) {
      const created = this.ctx.encryption.create(input.encryptionRequest)
      encryption = created.context
      transforms = [this.ctx.encryption.createEncryptStream(created.key, encryption, 0)]
    }

    const effectiveMax = this.ctx.maxObjectSize > 0 ? this.ctx.maxObjectSize : 0
    const { blobId, size, hasher } = await this.ctx.blobs.write(input.body, { algorithms, transforms, maxSize: effectiveMax })

    let metadataCommitted = false
    try {
      if (effectiveMax > 0 && size > effectiveMax) {
        throw new S3Error('EntityTooLarge')
      }

      const md5 = hasher.digest('md5', 'hex')

      if (input.contentMd5 && hasher.digest('md5', 'base64') !== input.contentMd5) {
        throw new S3Error('BadDigest')
      }
      if (input.expectedSha256 && hasher.digest('sha256', 'hex') !== input.expectedSha256) {
        throw new S3Error('XAmzContentSHA256Mismatch')
      }

      const checksums: Record<string, string> = {}
      if (input.checksumAlgorithm) {
        const computed = hasher.digest(input.checksumAlgorithm, 'base64')
        const declared = input.expectedChecksum ?? input.trailerProvider?.(`x-amz-checksum-${input.checksumAlgorithm}`) ?? null
        if (declared && declared !== computed) {
          throw checksumMismatch(input.checksumAlgorithm, declared, computed)
        }
        checksums[input.checksumAlgorithm] = computed
      }

      const etag = `"${md5}"`
      const lastModified = new Date()
      const versioning = this.buckets.bucketVersioning(input.bucket)
      const versionId = versioning === 'Enabled' ? newVersionId() : NULL_VERSION
      const replaced = versionId === NULL_VERSION
        ? this.ctx.metadata.getObject(input.bucket, input.key, NULL_VERSION)
        : null
      const lock = this.resolveNewObjectLock(input.bucket, input.lock)

      this.ctx.metadata.transaction(() => {
        this.ctx.metadata.clearLatest(input.bucket, input.key)
        this.ctx.metadata.putObject({
          bucket: input.bucket, key: input.key, versionId, isLatest: true, isDeleteMarker: false,
          size, etag, contentType: input.contentType, lastModified,
          blobId, parts: null, metadata: input.metadata ?? {}, checksums, tags: input.tags ?? {},
          encryption, ...lock,
        })
      })
      metadataCommitted = true

      if (replaced) await this.releaseObjectBlobs(replaced)

      return { etag, size, lastModified, checksums, versionId, versioned: versioning === 'Enabled', encryption }
    } catch (err) {
      if (!metadataCommitted) await this.ctx.blobs.remove(blobId)
      throw err
    }
  }

  getObject(bucket: string, key: string, versionId?: string | null): ObjectRecord {
    this.buckets.requireBucket(bucket)
    const record = this.ctx.metadata.getObject(bucket, key, versionId)
    if (!record) {
      throw new S3Error(versionId ? 'NoSuchVersion' : 'NoSuchKey', undefined, { key: String(key) })
    }
    if (record.isDeleteMarker) {
      throw new S3Error(versionId ? 'MethodNotAllowed' : 'NoSuchKey', undefined, {
        headers: { 'x-amz-delete-marker': 'true', 'x-amz-version-id': record.versionId },
      })
    }
    return record
  }

  resolveEncryptionKey(record: ObjectRecord, encryptionRequest: SseRequest | null | undefined): Buffer | null {
    if (!record.encryption) {
      if (encryptionRequest?.mode === 'SSE-C') {
        throw new S3Error('InvalidRequest', 'The object was not stored with SSE-C')
      }
      return null
    }
    return this.ctx.encryption.resolveKey(record.encryption, encryptionRequest ?? null)
  }

  createObjectStream(record: ObjectRecord, start = 0, end = record.size - 1, { encryptionKey = null }: { encryptionKey?: Buffer | null } = {}): Readable {
    if (record.size === 0 || end < start) return Readable.from([])

    const stored = record.encryption
    if (!stored) {
      return record.parts
        ? this.ctx.blobs.createRangeStream(record.parts, start, end)
        : this.ctx.blobs.createReadStream(record.blobId!, { start, end })
    }

    // resolveEncryptionKey always yields key material for an encrypted record;
    // failing loudly here beats streaming out ciphertext if that ever changes.
    if (!encryptionKey) {
      throw new S3Error('InvalidRequest', 'The object is encrypted but no key was resolved')
    }
    const key = encryptionKey
    const context: EncryptionContext = stored
    const { encryption, blobs } = this.ctx

    if (!record.parts) {
      // CTR mode is seekable only at block granularity, so the read starts on
      // the enclosing block and the decrypt chain drops the leading bytes.
      const aligned = blockAlignedOffset(start)
      return chainStreams(
        blobs.createReadStream(record.blobId!, { start: aligned, end }),
        ...encryption.createDecryptStreams(key, context, start, 0),
      )
    }

    const parts = record.parts
    async function* generate(): AsyncGenerator<Buffer> {
      for (const slice of sliceParts(parts, start, end)) {
        yield* chainStreams(
          blobs.createReadStream(slice.blobId, { start: blockAlignedOffset(slice.from), end: slice.to }),
          ...encryption.createDecryptStreams(key, context, slice.from, slice.partNumber),
        )
      }
    }
    return Readable.from(generate(), { highWaterMark: READ_HIGH_WATER_MARK })
  }

  async deleteObject(bucket: string, key: string, versionId?: string | null, { bypassGovernance = false } = {}): Promise<DeleteObjectResult> {
    this.buckets.requireBucket(bucket)
    const versioning = this.buckets.bucketVersioning(bucket)

    if (versionId) {
      const record = this.ctx.metadata.getObject(bucket, key, versionId)
      if (!record) return { deleted: false }
      // Object Lock only ever protects a concrete version. Deleting the "current"
      // object in a versioned bucket just writes a delete marker, which hides the
      // data without destroying it, so that path stays open.
      assertVersionDeletable(record, { bypassGovernance })
      this.ctx.metadata.transaction(() => {
        this.ctx.metadata.deleteVersion(bucket, key, versionId)
        if (record.isLatest) this.ctx.metadata.promoteLatest(bucket, key)
      })
      await this.releaseObjectBlobs(record)
      return { deleted: true, versionId, deleteMarker: record.isDeleteMarker }
    }

    if (versioning === 'Enabled' || versioning === 'Suspended') {
      const markerVersion = versioning === 'Enabled' ? newVersionId() : NULL_VERSION
      const replaced = markerVersion === NULL_VERSION
        ? this.ctx.metadata.getObject(bucket, key, NULL_VERSION)
        : null
      this.ctx.metadata.transaction(() => {
        this.ctx.metadata.clearLatest(bucket, key)
        this.ctx.metadata.putObject({
          bucket, key, versionId: markerVersion, isLatest: true, isDeleteMarker: true,
          size: 0, etag: '', lastModified: new Date(), blobId: null,
        })
      })
      if (replaced) await this.releaseObjectBlobs(replaced)
      return { deleted: true, versionId: markerVersion, deleteMarker: true }
    }

    const record = this.ctx.metadata.getObject(bucket, key)
    if (!record) return { deleted: false }
    // Without versioning a plain DELETE destroys the only copy, so the lock
    // applies here exactly as it does to an explicit version delete.
    assertVersionDeletable(record, { bypassGovernance })
    this.ctx.metadata.deleteVersion(bucket, key, record.versionId)
    await this.releaseObjectBlobs(record)
    return { deleted: true }
  }

  async copyObject(input: CopyObjectInput): Promise<CopyObjectResult> {
    const source = this.getObject(input.sourceBucket, input.sourceKey, input.sourceVersionId)
    this.buckets.requireBucket(input.bucket)
    validateKey(input.key)

    const sourceKeyMaterial = this.resolveEncryptionKey(source, input.sourceEncryptionRequest)
    const plaintext = this.createObjectStream(source, 0, source.size - 1,
      { encryptionKey: sourceKeyMaterial })

    let encryption: EncryptionContext | null = null
    let transforms: NodeJS.ReadWriteStream[] = []
    if (input.encryptionRequest) {
      const created = this.ctx.encryption.create(input.encryptionRequest)
      encryption = created.context
      transforms = [this.ctx.encryption.createEncryptStream(created.key, encryption, 0)]
    }

    const effectiveMax = this.ctx.maxObjectSize > 0 ? this.ctx.maxObjectSize : 0
    const { blobId, size, hasher } = await this.ctx.blobs.write(plaintext, { algorithms: ['md5'], transforms, maxSize: effectiveMax })
    let metadataCommitted = false
    try {
      if (effectiveMax > 0 && size > effectiveMax) throw new S3Error('EntityTooLarge')
      const etag = `"${hasher.digest('md5', 'hex')}"`
      const lastModified = new Date()
      const versioning = this.buckets.bucketVersioning(input.bucket)
      const versionId = versioning === 'Enabled' ? newVersionId() : NULL_VERSION
      const replaced = versionId === NULL_VERSION
        ? this.ctx.metadata.getObject(input.bucket, input.key, NULL_VERSION)
        : null

      this.ctx.metadata.transaction(() => {
        this.ctx.metadata.clearLatest(input.bucket, input.key)
        this.ctx.metadata.putObject({
          bucket: input.bucket, key: input.key, versionId, isLatest: true, isDeleteMarker: false,
          size, etag, lastModified,
          contentType: input.replaceMetadata ? input.contentType : source.contentType,
          blobId, parts: null,
          metadata: input.replaceMetadata ? (input.metadata ?? {}) : source.metadata,
          checksums: {},
          tags: input.replaceTags ? (input.tags ?? {}) : source.tags,
          encryption,
        })
      })
      metadataCommitted = true
      if (replaced) await this.releaseObjectBlobs(replaced)
      return { etag, lastModified, size, versionId, versioned: versioning === 'Enabled', encryption }
    } catch (err) {
      if (!metadataCommitted) await this.ctx.blobs.remove(blobId)
      throw err
    }
  }

  listObjects(bucket: string, options: ListObjectsOptions): ListObjectsResult {
    this.buckets.requireBucket(bucket)
    return this.ctx.metadata.listObjects(bucket, options)
  }

  listVersions(bucket: string, options: ListVersionsOptions): ListVersionsResult {
    this.buckets.requireBucket(bucket)
    return this.ctx.metadata.listVersions(bucket, options)
  }

  getObjectTags(bucket: string, key: string, versionId?: string | null): Record<string, string> {
    return this.getObject(bucket, key, versionId).tags ?? {}
  }

  setObjectTags(bucket: string, key: string, versionId: string | undefined | null, tags: Record<string, string>): string {
    const record = this.getObject(bucket, key, versionId)
    this.ctx.metadata.setTags(bucket, key, record.versionId, tags)
    return record.versionId
  }

  /** Merges explicit lock headers over the bucket's default retention. */
  private resolveNewObjectLock(bucket: string, requested?: Partial<LockState> | null): Partial<LockState> {
    const config = this.buckets.getBucketConfig<ObjectLockConfig>(bucket, 'object-lock')
    const defaults = applyDefaultRetention(config)
    return { ...defaults, ...(requested ?? {}) }
  }

  getObjectLock(bucket: string, key: string, versionId?: string | null): LockState {
    const record = this.getObject(bucket, key, versionId)
    return {
      retentionMode: record.retentionMode,
      retainUntil: record.retainUntil,
      legalHold: record.legalHold,
    }
  }

  /** Sets retention on one version, refusing to weaken an active COMPLIANCE lock. */
  setRetention(bucket: string, key: string, versionId: string | null | undefined, retention: Retention, { bypassGovernance = false } = {}): string {
    this.requireLockEnabled(bucket)
    const record = this.getObject(bucket, key, versionId)
    assertRetentionReplaceable(record, retention, { bypassGovernance })
    this.ctx.metadata.setLock(bucket, key, record.versionId, {
      retentionMode: retention.mode,
      retainUntil: retention.retainUntil,
      legalHold: record.legalHold,
    })
    return record.versionId
  }

  setLegalHold(bucket: string, key: string, versionId: string | null | undefined, held: boolean): string {
    this.requireLockEnabled(bucket)
    const record = this.getObject(bucket, key, versionId)
    this.ctx.metadata.setLock(bucket, key, record.versionId, {
      retentionMode: record.retentionMode,
      retainUntil: record.retainUntil,
      legalHold: held,
    })
    return record.versionId
  }

  private requireLockEnabled(bucket: string): void {
    const config = this.buckets.getBucketConfig<ObjectLockConfig>(bucket, 'object-lock')
    if (!config?.enabled) {
      throw new S3Error('InvalidRequest', 'Object Lock is not enabled for this bucket')
    }
  }

  /** Drops every blob a record owns, whether it is single-blob or multipart. */
  async releaseObjectBlobs(record: ObjectRecord): Promise<void> {
    const ids: string[] = []
    if (record.blobId) ids.push(record.blobId)
    if (record.parts) for (const part of record.parts) ids.push(part.blobId)
    await this.ctx.blobs.removeMany(ids)
  }
}
