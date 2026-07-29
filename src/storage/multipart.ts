import { randomUUID } from 'node:crypto'
import { S3Error } from '../errors.js'
import type { EncryptionContext } from '../features/encryption.js'
import { toKeyBuffer } from '../util/bytes.js'
import { multipartEtag } from '../util/hash.js'
import type { BlobPart } from './blobs.js'
import type { BucketService } from './buckets.js'
import {
  MAX_PARTS,
  checksumMismatch,
  newVersionId,
  validateKey,
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

  createMultipartUpload({ bucket, key, contentType, metadata = {}, tags = {}, encryptionRequest = null }: CreateMultipartInput): CreateMultipartResult {
    this.buckets.requireBucket(bucket)
    validateKey(key)
    if (this.ctx.maxConcurrentUploads > 0 && this.ctx.metadata.uploadCount(bucket) >= this.ctx.maxConcurrentUploads) {
      throw new S3Error('SlowDown', `Too many concurrent multipart uploads for bucket ${bucket}`)
    }
    const uploadId = randomUUID().replaceAll('-', '')
    const encryption = encryptionRequest ? this.ctx.encryption.create(encryptionRequest).context : null
    this.ctx.metadata.createUpload({
      uploadId, bucket, key, contentType, metadata, tags, encryption,
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
    const { blobId, size, hasher } = await this.ctx.blobs.write(input.body, { algorithms, transforms, maxSize: effectiveMax })
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
      const previous = this.ctx.metadata.getPart(input.uploadId, input.partNumber)
      this.ctx.metadata.putPart({ uploadId: input.uploadId, partNumber: input.partNumber, size, etag, blobId })
      metadataCommitted = true
      if (previous) await this.ctx.blobs.remove(previous.blobId)
      return { etag, size, encryption: uploadEncryption }
    } catch (err) {
      if (!metadataCommitted) await this.ctx.blobs.remove(blobId)
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
    const { blobId, size, hasher } = await this.ctx.blobs.write(plaintext, {
      algorithms: ['md5'], transforms, maxSize: effectiveMax,
    })

    let metadataCommitted = false
    try {
      const etag = `"${hasher.digest('md5', 'hex')}"`
      const previous = this.ctx.metadata.getPart(input.uploadId, input.partNumber)
      this.ctx.metadata.putPart({ uploadId: input.uploadId, partNumber: input.partNumber, size, etag, blobId })
      metadataCommitted = true
      if (previous) await this.ctx.blobs.remove(previous.blobId)
      return {
        etag,
        size,
        lastModified: new Date(),
        encryption: uploadEncryption,
        sourceVersionId: source.versionId === NULL_VERSION ? null : source.versionId,
      }
    } catch (err) {
      if (!metadataCommitted) await this.ctx.blobs.remove(blobId)
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
    const upload = this.requireUpload(input.uploadId, input.bucket, input.key)
    if (!input.requestedParts.length) throw new S3Error('InvalidRequest', 'You must specify at least one part')

    const stored = new Map<number, PartRecord>(
      this.ctx.metadata.allParts(input.uploadId).map((part) => [part.partNumber, part]))
    const manifest = this.buildManifest(input, stored)

    const size = manifest.reduce((total, part) => total + part.size, 0)
    if (this.ctx.maxObjectSize > 0 && size > this.ctx.maxObjectSize) {
      throw new S3Error('EntityTooLarge')
    }
    const etag = `"${multipartEtag(manifest.map((part) => part.etag.replaceAll('"', '')))}"`
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
        contentType: upload.contentType,
        blobId: null, parts: manifest,
        metadata: upload.metadata, checksums: {},
        tags: upload.tags, encryption: upload.encryption,
      })
      this.ctx.metadata.deleteUpload(input.uploadId)
    })

    const kept = new Set(manifest.map((part) => part.blobId))
    const discarded = [...stored.values()].map((part) => part.blobId).filter((id) => !kept.has(id))
    await this.ctx.blobs.removeMany(discarded)
    if (replaced) await this.objects.releaseObjectBlobs(replaced)

    return {
      etag, size, lastModified, checksums: {}, versionId,
      versioned: versioning === 'Enabled',
      encryption: upload.encryption,
    }
  }

  async abortMultipartUpload(input: AbortMultipartInput): Promise<void> {
    this.requireUpload(input.uploadId, input.bucket, input.key)
    const parts = this.ctx.metadata.allParts(input.uploadId)
    this.ctx.metadata.deleteUpload(input.uploadId)
    await this.ctx.blobs.removeMany(parts.map((part) => part.blobId))
  }
}
