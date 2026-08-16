import { randomUUID } from 'node:crypto'
import { S3Error } from '../errors.js'
import { faultPoint } from '../faults.js'
import type { EncryptionContext } from '../features/encryption.js'
import { toKeyBuffer } from '../util/bytes.js'
import { multipartEtag } from '../util/hash.js'
import type { BlobPart, WriteResult } from './blobs.js'
import type { BucketService } from './buckets.js'
import {
  MAX_PARTS,
  acquireWriteSlot,
  assertWithinQuota,
  checksumMismatch,
  newVersionId,
  validateKey,
  writeReservedBlob,
  type StoreContext,
} from './context.js'
import { NULL_VERSION, type PartRecord, type UploadRecord } from './metadata.js'
import type { ObjectService } from './objects.js'
import type {
  AbortMultipartInput,
  CompleteMultipartInput,
  CreateMultipartInput,
  CreateMultipartResult,
  ListPartsOptions,
  PutObjectResult,
  UploadPartCopyInput,
  UploadPartCopyResult,
  UploadPartInput,
  UploadPartResult,
} from './types.js'

/** Strips the quoting an ETag may carry, in raw or XML-escaped form. */
function normalizeEtag(etag: string): string {
  return etag.replaceAll('"', '').replace(/^&quot;|&quot;$/g, '')
}

/** Multipart upload lifecycle: create, upload parts, complete or abort. */
export class MultipartService {
  constructor(
    private readonly ctx: StoreContext,
    private readonly buckets: BucketService,
    private readonly objects: ObjectService,
  ) {}

  createMultipartUpload({ bucket, key, contentType, metadata = {}, tags = {}, encryptionRequest = null, lock: requestedLock = null }: CreateMultipartInput): CreateMultipartResult {
    validateKey(key)
    const uploadId = randomUUID().replaceAll('-', '')
    const encryption = encryptionRequest ? this.ctx.encryption.create(encryptionRequest).context : null
    this.ctx.metadata.transaction(() => {
      this.buckets.requireBucket(bucket)
      if (this.ctx.maxConcurrentUploads > 0 && this.ctx.metadata.uploadCount(bucket) >= this.ctx.maxConcurrentUploads) {
        throw new S3Error('SlowDown', `Too many concurrent multipart uploads for bucket ${bucket}`)
      }
      const lock = this.objects.resolveNewObjectLock(bucket, requestedLock)
      this.ctx.metadata.createUpload({
        uploadId, bucket, key, contentType, metadata, tags, encryption, lock,
      })
    })
    return { uploadId, encryption }
  }

  requireUpload(uploadId: string, bucket: string, key: string): UploadRecord {
    const upload = this.ctx.metadata.getUpload(uploadId)
    if (!upload || upload.bucket !== bucket || Buffer.compare(upload.key, toKeyBuffer(key)) !== 0) {
      throw new S3Error('NoSuchUpload')
    }
    return upload
  }

  async uploadPart(input: UploadPartInput): Promise<UploadPartResult> {
    const upload = this.requireUpload(input.uploadId, input.bucket, input.key)
    if (!Number.isInteger(input.partNumber) || input.partNumber < 1 || input.partNumber > MAX_PARTS) {
      throw new S3Error('InvalidArgument', `Part number must be an integer between 1 and ${MAX_PARTS}`)
    }

    const algorithms = ['md5']
    if (input.expectedSha256) algorithms.push('sha256')
    if (input.checksumAlgorithm) algorithms.push(input.checksumAlgorithm)

    const uploadEncryption = upload.encryption
    let transforms: NodeJS.ReadWriteStream[] = []
    if (uploadEncryption) {
      const dataKey = this.ctx.encryption.resolveKey(uploadEncryption, input.encryptionRequest ?? null)
      transforms = [this.ctx.encryption.createEncryptStream(dataKey!, uploadEncryption, input.partNumber)]
    }

    const effectiveMax = this.ctx.maxObjectSize > 0 ? this.ctx.maxObjectSize : 0
    const release = await acquireWriteSlot(this.ctx)
    let blobId: string, size: number, hasher: WriteResult['hasher']
    try {
      ({ blobId, size, hasher } = await writeReservedBlob(
        this.ctx, input.body, { algorithms, transforms, maxSize: effectiveMax }))
      faultPoint('multipart-part:after-blob')
    } finally {
      release()
    }
    let metadataCommitted = false
    try {
      if (effectiveMax > 0 && size > effectiveMax) throw new S3Error('EntityTooLarge')
      if (input.contentMd5 && hasher.digest('md5', 'base64') !== input.contentMd5) throw new S3Error('BadDigest')
      if (input.expectedSha256 && hasher.digest('sha256', 'hex') !== input.expectedSha256) {
        throw new S3Error('XAmzContentSHA256Mismatch')
      }
      if (input.checksumAlgorithm) {
        const computed = hasher.digest(input.checksumAlgorithm, 'base64')
        const declared = input.expectedChecksum ?? input.trailerProvider?.(`x-amz-checksum-${input.checksumAlgorithm}`) ?? null
        if (declared && declared !== computed) throw checksumMismatch(input.checksumAlgorithm, declared, computed)
      }

      const etag = `"${hasher.digest('md5', 'hex')}"`
      const previous: { value: PartRecord | null } = { value: null }
      this.ctx.metadata.transaction(() => {
        this.requireUpload(input.uploadId, input.bucket, input.key)
        previous.value = this.ctx.metadata.getPart(input.uploadId, input.partNumber)
        if (!this.ctx.metadata.putPart({ uploadId: input.uploadId, partNumber: input.partNumber, size, etag, blobId })) {
          throw new S3Error('NoSuchUpload')
        }
        this.ctx.metadata.releasePendingBlob(blobId)
      })
      metadataCommitted = true
      faultPoint('multipart-part:after-metadata')
      if (previous.value) await this.ctx.blobs.remove(previous.value.blobId)
      return { etag, size, encryption: uploadEncryption }
    } catch (err) {
      if (!metadataCommitted) {
        this.ctx.metadata.releasePendingBlob(blobId)
        await this.ctx.blobs.remove(blobId)
      }
      throw err
    }
  }

  /**
   * Copies a byte range of an existing object straight into a part blob, so
   * the bytes never leave the server. The source is decrypted on the way out
   * and re-encrypted under the destination upload's key, which is why this
   * cannot be a plain file copy.
   */
  async uploadPartCopy(input: UploadPartCopyInput): Promise<UploadPartCopyResult> {
    const upload = this.requireUpload(input.uploadId, input.bucket, input.key)
    if (!Number.isInteger(input.partNumber) || input.partNumber < 1 || input.partNumber > MAX_PARTS) {
      throw new S3Error('InvalidArgument', `Part number must be an integer between 1 and ${MAX_PARTS}`)
    }

    const source = this.objects.getObject(input.sourceBucket, input.sourceKey, input.sourceVersionId)
    const range = input.sourceRange ?? { start: 0, end: Math.max(source.size - 1, 0) }
    if (range.start < 0 || range.start >= Math.max(source.size, 1) || range.end < range.start) {
      throw new S3Error('InvalidArgument', 'The x-amz-copy-source-range is not satisfiable')
    }

    const sourceKeyMaterial = this.objects.resolveEncryptionKey(source, input.sourceEncryptionRequest)
    const plaintext = this.objects.createObjectStream(source, range.start, range.end,
      { encryptionKey: sourceKeyMaterial })

    const uploadEncryption = upload.encryption
    let transforms: NodeJS.ReadWriteStream[] = []
    if (uploadEncryption) {
      const dataKey = this.ctx.encryption.resolveKey(uploadEncryption, input.encryptionRequest ?? null)
      transforms = [this.ctx.encryption.createEncryptStream(dataKey!, uploadEncryption, input.partNumber)]
    }

    const effectiveMax = this.ctx.maxObjectSize > 0 ? this.ctx.maxObjectSize : 0
    const copyRelease = await acquireWriteSlot(this.ctx)
    let blobId: string, size: number, hasher: WriteResult['hasher']
    try {
      ({ blobId, size, hasher } = await writeReservedBlob(this.ctx, plaintext, {
        algorithms: ['md5'], transforms, maxSize: effectiveMax,
      }))
    } finally {
      copyRelease()
    }

    let metadataCommitted = false
    try {
      const etag = `"${hasher.digest('md5', 'hex')}"`
      const previous: { value: PartRecord | null } = { value: null }
      this.ctx.metadata.transaction(() => {
        this.requireUpload(input.uploadId, input.bucket, input.key)
        previous.value = this.ctx.metadata.getPart(input.uploadId, input.partNumber)
        if (!this.ctx.metadata.putPart({ uploadId: input.uploadId, partNumber: input.partNumber, size, etag, blobId })) {
          throw new S3Error('NoSuchUpload')
        }
        this.ctx.metadata.releasePendingBlob(blobId)
      })
      metadataCommitted = true
      if (previous.value) await this.ctx.blobs.remove(previous.value.blobId)
      return {
        etag,
        size,
        lastModified: new Date(),
        encryption: uploadEncryption,
        sourceVersionId: source.versionId === NULL_VERSION ? null : source.versionId,
      }
    } catch (err) {
      if (!metadataCommitted) {
        this.ctx.metadata.releasePendingBlob(blobId)
        await this.ctx.blobs.remove(blobId)
      }
      throw err
    }
  }

  listParts(bucket: string, key: string, uploadId: string, options: ListPartsOptions): PartRecord[] {
    this.requireUpload(uploadId, bucket, key)
    return this.ctx.metadata.listParts(uploadId, options)
  }

  listMultipartUploads(bucket: string, maxUploads: number): UploadRecord[] {
    this.buckets.requireBucket(bucket)
    return this.ctx.metadata.listUploads(bucket, maxUploads)
  }

  /**
   * Validates the requested manifest against what was actually uploaded, then
   * publishes it as a single object. Every part but the last must reach
   * minPartSize, matching S3's rule.
   */
  private buildManifest(input: CompleteMultipartInput, stored: Map<number, PartRecord>): BlobPart[] {
    const manifest: BlobPart[] = []
    let previousNumber = 0

    for (const [index, requested] of input.requestedParts.entries()) {
      if (requested.partNumber <= previousNumber) throw new S3Error('InvalidPartOrder')
      previousNumber = requested.partNumber

      const part = stored.get(requested.partNumber)
      if (!part) {
        throw new S3Error('InvalidPart', `Part ${requested.partNumber} was not uploaded`)
      }
      if (normalizeEtag(part.etag) !== normalizeEtag(requested.etag)) {
        throw new S3Error('InvalidPart', `ETag mismatch for part ${requested.partNumber}`)
      }
      if (index < input.requestedParts.length - 1 && part.size < this.ctx.minPartSize) {
        throw new S3Error('EntityTooSmall',
          `Part ${requested.partNumber} is ${part.size} bytes; the minimum is ${this.ctx.minPartSize}`)
      }
      manifest.push({ partNumber: part.partNumber, size: part.size, etag: part.etag, blobId: part.blobId })
    }

    return manifest
  }

  async completeMultipartUpload(input: CompleteMultipartInput): Promise<PutObjectResult> {
    if (!input.requestedParts.length) throw new S3Error('InvalidRequest', 'You must specify at least one part')
    let upload: UploadRecord | null = null
    let stored = new Map<number, PartRecord>()
    let manifest: BlobPart[] = []
    let size = 0
    let etag = ''
    const lastModified = new Date()
    let versioning = 'Unset'
    let versionId = NULL_VERSION
    let replaced: import('./metadata.js').ObjectRecord | null = null

    this.ctx.metadata.transaction(() => {
      upload = this.requireUpload(input.uploadId, input.bucket, input.key)
      stored = new Map<number, PartRecord>(
        this.ctx.metadata.allParts(input.uploadId).map((part) => [part.partNumber, part]))
      manifest = this.buildManifest(input, stored)
      size = manifest.reduce((total, part) => total + part.size, 0)
      if (this.ctx.maxObjectSize > 0 && size > this.ctx.maxObjectSize) throw new S3Error('EntityTooLarge')
      assertWithinQuota(this.ctx, input.bucket, size)
      etag = `"${multipartEtag(manifest.map((part) => part.etag.replaceAll('"', '')))}"`
      versioning = this.buckets.bucketVersioning(input.bucket)
      versionId = versioning === 'Enabled' ? newVersionId() : NULL_VERSION
      replaced = versionId === NULL_VERSION
        ? this.ctx.metadata.getObject(input.bucket, input.key, NULL_VERSION)
        : null
      this.ctx.metadata.clearLatest(input.bucket, input.key)
      this.ctx.metadata.putObject({
        bucket: input.bucket, key: input.key, versionId, isLatest: true, isDeleteMarker: false,
        size, etag, lastModified,
        contentType: upload.contentType,
        blobId: null, parts: manifest,
        metadata: upload.metadata, checksums: {},
        tags: upload.tags, encryption: upload.encryption,
        retentionMode: upload.retentionMode, retainUntil: upload.retainUntil,
        legalHold: upload.legalHold,
      })
      this.ctx.metadata.deleteUpload(input.uploadId)
    })
    faultPoint('multipart-complete:after-metadata')

    const kept = new Set(manifest.map((part) => part.blobId))
    const discarded = [...stored.values()].map((part) => part.blobId).filter((id) => !kept.has(id))
    await this.ctx.blobs.removeMany(discarded)
    if (replaced) await this.objects.releaseObjectBlobs(replaced)

    return {
      etag, size, lastModified, checksums: {}, versionId,
      versioned: versioning === 'Enabled',
      encryption: upload!.encryption,
    }
  }

  async abortMultipartUpload(input: AbortMultipartInput): Promise<void> {
    let parts: PartRecord[] = []
    this.ctx.metadata.transaction(() => {
      this.requireUpload(input.uploadId, input.bucket, input.key)
      parts = this.ctx.metadata.allParts(input.uploadId)
      this.ctx.metadata.deleteUpload(input.uploadId)
    })
    await this.ctx.blobs.removeMany(parts.map((part) => part.blobId))
  }
}
