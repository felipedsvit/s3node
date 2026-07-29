/**
 * Shared plumbing for the storage services.
 *
 * `StoreContext` is the single dependency bundle every service takes. Because
 * its collaborators are already resolved by the time a service is constructed,
 * services can use `this.ctx.metadata` directly — no null checks, no `!`.
 */

import { randomUUID } from 'node:crypto'
import { PassThrough, Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { S3Error } from '../errors.js'
import type { EncryptionManager } from '../features/encryption.js'
import { toKeyBuffer } from '../util/bytes.js'
import { Semaphore } from '../util/semaphore.js'
import { READ_HIGH_WATER_MARK, type BlobStore } from './blobs.js'
import type { MetadataStore } from './metadata.js'

export const MAX_KEY_BYTES = 1024
export const DEFAULT_MIN_PART_SIZE = 5 * 1024 * 1024
export const MAX_OBJECT_SIZE = 5 * 1024 * 1024 * 1024 * 1024
export const MAX_CONCURRENT_UPLOADS = 1000
export const MAX_PARTS = 10_000
/** 0 keeps the write semaphore disabled, matching `maxConcurrentUploads`'s own default-off convention. */
export const MAX_CONCURRENT_WRITES = 0
export const WRITE_SEMAPHORE_TIMEOUT_MS = 30_000

export const CONFIG_NAMES = ['versioning', 'policy', 'cors', 'lifecycle', 'tagging', 'notification', 'quota']

/** Bucket-level quota document, stored under the `quota` bucket config name. */
export interface BucketQuota {
  maxBucketSize?: number
  maxObjects?: number
}

/** Tunables that shape what the services accept. */
export interface StoreLimits {
  region: string
  minPartSize: number
  maxObjectSize: number
  maxConcurrentUploads: number
  maxConcurrentWrites: number
}

/** Everything a storage service depends on, fully constructed. */
export interface StoreContext extends StoreLimits {
  metadata: MetadataStore
  blobs: BlobStore
  encryption: EncryptionManager
  writeSemaphore: Semaphore
}

/**
 * Reserves a slot before a blob write. Rejected as `SlowDown` (same error
 * `maxConcurrentUploads` already uses) rather than queuing indefinitely, so a
 * saturated server sheds load instead of piling up pending writers.
 */
export async function acquireWriteSlot(ctx: StoreContext): Promise<() => void> {
  try {
    return await ctx.writeSemaphore.acquire(WRITE_SEMAPHORE_TIMEOUT_MS)
  } catch {
    throw new S3Error('SlowDown', 'Too many concurrent writes')
  }
}

/**
 * Rejects a write before it touches disk if it would push the bucket past its
 * configured quota. Deliberately conservative: an overwrite of an existing
 * key is counted as if it were a new one, so a bucket sitting exactly at
 * `maxObjects` may reject an overwrite that wouldn't actually grow the count
 * — avoiding that would need an extra existence lookup per write, which
 * isn't worth it just to shave one edge case off an already-approximate limit.
 */
export function assertWithinQuota(ctx: StoreContext, bucket: string, incomingSize: number): void {
  const quota = ctx.metadata.getConfig<BucketQuota>(bucket, 'quota')
  if (!quota) return
  const usage = ctx.metadata.bucketUsage(bucket)
  if (quota.maxObjects && usage.objects + 1 > quota.maxObjects) {
    throw new S3Error('QuotaExceeded', `Bucket ${bucket} already has ${usage.objects} objects (limit ${quota.maxObjects})`)
  }
  if (quota.maxBucketSize && usage.bytes + incomingSize > quota.maxBucketSize) {
    throw new S3Error('QuotaExceeded', `Bucket ${bucket} would exceed its ${quota.maxBucketSize}-byte quota`)
  }
}

const BUCKET_NAME_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/

export function validateBucketName(name: string): string {
  if (!BUCKET_NAME_RE.test(name) || name.includes('..') || IPV4_RE.test(name)) {
    throw new S3Error('InvalidBucketName')
  }
  return name
}

export function validateKey(key: string): string {
  const buf = toKeyBuffer(key)
  if (buf.length === 0) throw new S3Error('InvalidArgument', 'Object key must not be empty')
  if (buf.length > MAX_KEY_BYTES) throw new S3Error('KeyTooLongError')
  return key
}

export function newVersionId(): string {
  return randomUUID().replaceAll('-', '')
}

export function checksumMismatch(algorithm: string, expected: string, actual: string): S3Error {
  return new S3Error(
    'InvalidRequest',
    `Value for x-amz-checksum-${algorithm} header is invalid: expected ${expected}, computed ${actual}`,
  )
}

/** Pipes a source through zero or more transforms and exposes the far end. */
export function chainStreams(...streams: (NodeJS.ReadableStream | NodeJS.ReadWriteStream)[]): Readable {
  if (streams.length === 1) return streams[0] as Readable
  const output = new PassThrough({ highWaterMark: READ_HIGH_WATER_MARK })
  // Spread, never an array: `pipeline([a, b], dest)` treats the array as an
  // iterable *source* and writes the stream objects themselves as chunks.
  ;(pipeline as (...args: unknown[]) => Promise<void>)(...streams, output)
    .catch((err: Error) => output.destroy(err))
  return output
}
