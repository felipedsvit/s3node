import { S3Error } from '../errors.js'
import { validateBucketName, type StoreContext } from './context.js'
import type { BucketRecord } from './metadata.js'

/** Buckets and their per-bucket configuration documents. */
export class BucketService {
  constructor(private readonly ctx: StoreContext) {}

  requireBucket(name: string): BucketRecord {
    const bucket = this.ctx.metadata.getBucket(name)
    if (!bucket) throw new S3Error('NoSuchBucket', undefined, { bucketName: name })
    return bucket
  }

  createBucket(name: string): void {
    validateBucketName(name)
    if (this.ctx.metadata.getBucket(name)) throw new S3Error('BucketAlreadyOwnedByYou')
    this.ctx.metadata.createBucket(name, this.ctx.region)
  }

  async deleteBucket(name: string): Promise<void> {
    this.requireBucket(name)
    if (!this.ctx.metadata.isBucketEmpty(name)) throw new S3Error('BucketNotEmpty')
    const orphans = this.ctx.metadata.blobsInBucket(name)
    this.ctx.metadata.deleteBucket(name)
    await this.ctx.blobs.removeMany(orphans)
  }

  listBuckets(): BucketRecord[] {
    return this.ctx.metadata.listBuckets()
  }

  /**
   * Config documents are stored as opaque JSON, so the caller names the shape
   * it expects. That keeps the cast at the one place that knows which parser
   * wrote the document, instead of at every read site.
   */
  getBucketConfig<T = Record<string, unknown>>(bucket: string, name: string): T | null {
    this.requireBucket(bucket)
    return this.ctx.metadata.getConfig(bucket, name) as T | null
  }

  putBucketConfig(bucket: string, name: string, value: unknown): void {
    this.requireBucket(bucket)
    this.ctx.metadata.putConfig(bucket, name, value)
  }

  deleteBucketConfig(bucket: string, name: string): void {
    this.requireBucket(bucket)
    this.ctx.metadata.deleteConfig(bucket, name)
  }

  bucketVersioning(bucket: string): string {
    const config = this.ctx.metadata.getConfig(bucket, 'versioning') as { status?: string } | null
    return config?.status ?? 'Unset'
  }
}
