import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { EncryptionManager, type SseRequest } from '../features/encryption.js'
import type { LockState, Retention } from '../features/objectlock.js'
import { CHECKSUM_ALGORITHMS } from '../util/hash.js'
import { BlobStore, READ_HIGH_WATER_MARK } from './blobs.js'
import { BucketService } from './buckets.js'
import {
  DEFAULT_MIN_PART_SIZE,
  MAX_CONCURRENT_UPLOADS,
  MAX_OBJECT_SIZE,
  type StoreContext,
} from './context.js'
import { MetadataStore, NULL_VERSION, type BucketRecord, type ObjectRecord, type UploadRecord, type PartRecord, type ListObjectsResult, type ListVersionsResult } from './metadata.js'
import { MultipartService } from './multipart.js'
import { ObjectService } from './objects.js'
import type {
  AbortMultipartInput,
  CompleteMultipartInput,
  CopyObjectInput,
  CopyObjectResult,
  CreateMultipartInput,
  CreateMultipartResult,
  DeleteObjectResult,
  ListObjectsOptions,
  ListPartsOptions,
  ListVersionsOptions,
  PutObjectInput,
  PutObjectResult,
  UploadPartCopyInput,
  UploadPartCopyResult,
  UploadPartInput,
  UploadPartResult,
} from './types.js'

export {
  CONFIG_NAMES,
  DEFAULT_MIN_PART_SIZE,
  MAX_CONCURRENT_UPLOADS,
  MAX_KEY_BYTES,
  MAX_OBJECT_SIZE,
  MAX_PARTS,
  validateBucketName,
  validateKey,
} from './context.js'
export { READ_HIGH_WATER_MARK }
export type { StoreContext, StoreLimits } from './context.js'
export { BucketService } from './buckets.js'
export { ObjectService } from './objects.js'
export { MultipartService } from './multipart.js'
export type * from './types.js'

export interface ObjectStoreOptions {
  dataDir: string
  region?: string
  minPartSize?: number
  maxObjectSize?: number
  maxConcurrentUploads?: number
}

export interface OpenOptions extends ObjectStoreOptions {
  encryptionMasterKey?: string | Buffer | null
}

/**
 * Facade over the three storage services. Callers get one object with the whole
 * S3 surface; the services behind it stay focused and independently testable.
 *
 * Construct with a fully-resolved `StoreContext` — use `ObjectStore.open()` to
 * build one from a directory on disk, or pass your own to substitute a
 * collaborator (an in-memory BlobStore, a fixed EncryptionManager) in tests.
 */
export class ObjectStore {
  readonly buckets: BucketService
  readonly objects: ObjectService
  readonly multipart: MultipartService

  constructor(private readonly ctx: StoreContext) {
    this.buckets = new BucketService(ctx)
    this.objects = new ObjectService(ctx, this.buckets)
    this.multipart = new MultipartService(ctx, this.buckets, this.objects)
  }

  static async open(options: OpenOptions): Promise<ObjectStore> {
    await mkdir(options.dataDir, { recursive: true })
    const blobs = new BlobStore(options.dataDir)
    await blobs.init()
    return new ObjectStore({
      metadata: new MetadataStore(join(options.dataDir, 'metadata.sqlite')),
      blobs,
      encryption: await EncryptionManager.load(
        join(options.dataDir, 'master.key'), options.encryptionMasterKey ?? null),
      region: options.region ?? 'us-east-1',
      minPartSize: options.minPartSize ?? DEFAULT_MIN_PART_SIZE,
      maxObjectSize: options.maxObjectSize ?? MAX_OBJECT_SIZE,
      maxConcurrentUploads: options.maxConcurrentUploads ?? MAX_CONCURRENT_UPLOADS,
    })
  }

  get metadata(): MetadataStore { return this.ctx.metadata }
  get blobs(): BlobStore { return this.ctx.blobs }
  get encryption(): EncryptionManager { return this.ctx.encryption }
  get region(): string { return this.ctx.region }
  get minPartSize(): number { return this.ctx.minPartSize }
  get maxObjectSize(): number { return this.ctx.maxObjectSize }
  get maxConcurrentUploads(): number { return this.ctx.maxConcurrentUploads }

  close(): void {
    this.ctx.metadata.close()
  }

  // Buckets
  requireBucket(name: string): BucketRecord { return this.buckets.requireBucket(name) }
  createBucket(name: string): void { this.buckets.createBucket(name) }
  deleteBucket(name: string): Promise<void> { return this.buckets.deleteBucket(name) }
  listBuckets(): BucketRecord[] { return this.buckets.listBuckets() }
  getBucketConfig<T = Record<string, unknown>>(bucket: string, name: string): T | null {
    return this.buckets.getBucketConfig<T>(bucket, name)
  }
  putBucketConfig(bucket: string, name: string, value: unknown): void {
    this.buckets.putBucketConfig(bucket, name, value)
  }
  deleteBucketConfig(bucket: string, name: string): void {
    this.buckets.deleteBucketConfig(bucket, name)
  }
  bucketVersioning(bucket: string): string { return this.buckets.bucketVersioning(bucket) }

  // Objects
  putObject(input: PutObjectInput): Promise<PutObjectResult> { return this.objects.putObject(input) }
  getObject(bucket: string, key: string, versionId?: string | null): ObjectRecord {
    return this.objects.getObject(bucket, key, versionId)
  }
  copyObject(input: CopyObjectInput): Promise<CopyObjectResult> { return this.objects.copyObject(input) }
  deleteObject(bucket: string, key: string, versionId?: string | null, options?: { bypassGovernance?: boolean }): Promise<DeleteObjectResult> {
    return this.objects.deleteObject(bucket, key, versionId, options)
  }
  getObjectLock(bucket: string, key: string, versionId?: string | null): LockState {
    return this.objects.getObjectLock(bucket, key, versionId)
  }
  setRetention(bucket: string, key: string, versionId: string | null | undefined, retention: Retention, options?: { bypassGovernance?: boolean }): string {
    return this.objects.setRetention(bucket, key, versionId, retention, options)
  }
  setLegalHold(bucket: string, key: string, versionId: string | null | undefined, held: boolean): string {
    return this.objects.setLegalHold(bucket, key, versionId, held)
  }
  resolveEncryptionKey(record: ObjectRecord, encryptionRequest: SseRequest | null | undefined): Buffer | null {
    return this.objects.resolveEncryptionKey(record, encryptionRequest)
  }
  createObjectStream(record: ObjectRecord, start?: number, end?: number, options?: { encryptionKey?: Buffer | null }): Readable {
    return this.objects.createObjectStream(record, start, end, options)
  }
  listObjects(bucket: string, options: ListObjectsOptions): ListObjectsResult {
    return this.objects.listObjects(bucket, options)
  }
  listVersions(bucket: string, options: ListVersionsOptions): ListVersionsResult {
    return this.objects.listVersions(bucket, options)
  }
  getObjectTags(bucket: string, key: string, versionId?: string | null): Record<string, string> {
    return this.objects.getObjectTags(bucket, key, versionId)
  }
  setObjectTags(bucket: string, key: string, versionId: string | undefined | null, tags: Record<string, string>): string {
    return this.objects.setObjectTags(bucket, key, versionId, tags)
  }

  // Multipart
  createMultipartUpload(input: CreateMultipartInput): CreateMultipartResult {
    return this.multipart.createMultipartUpload(input)
  }
  requireUpload(uploadId: string, bucket: string, key: string): UploadRecord {
    return this.multipart.requireUpload(uploadId, bucket, key)
  }
  uploadPart(input: UploadPartInput): Promise<UploadPartResult> { return this.multipart.uploadPart(input) }
  uploadPartCopy(input: UploadPartCopyInput): Promise<UploadPartCopyResult> {
    return this.multipart.uploadPartCopy(input)
  }
  listParts(bucket: string, key: string, uploadId: string, options: ListPartsOptions): PartRecord[] {
    return this.multipart.listParts(bucket, key, uploadId, options)
  }
  listMultipartUploads(bucket: string, maxUploads: number): UploadRecord[] {
    return this.multipart.listMultipartUploads(bucket, maxUploads)
  }
  completeMultipartUpload(input: CompleteMultipartInput): Promise<PutObjectResult> {
    return this.multipart.completeMultipartUpload(input)
  }
  abortMultipartUpload(input: AbortMultipartInput): Promise<void> {
    return this.multipart.abortMultipartUpload(input)
  }
}

export { CHECKSUM_ALGORITHMS, NULL_VERSION }
