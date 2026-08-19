import { DatabaseSync } from 'node:sqlite'
import { BucketMetadata } from './metadata/buckets.js'
import { MultipartMetadata } from './metadata/multipart.js'
import { NotificationMetadata } from './metadata/notifications.js'
import { ObjectMetadata } from './metadata/objects.js'
import { faultPoint } from '../faults.js'
import { migrateV1ToV2, migrateV2ToV3, migrateV4ToV5, migrateV5ToV6, NULL_VERSION, SCHEMA, SCHEMA_VERSION } from './metadata/schema.js'
import type { BucketRecord, ListObjectsResult, ListVersionsResult, NotificationQueueRow, ObjectInput, ObjectRecord, PartRecord, UploadRecord } from './metadata/types.js'

export { NULL_VERSION, SCHEMA_VERSION }
export type { BucketRecord, ListObjectsResult, ListVersionsResult, NotificationQueueRow, ObjectInput, ObjectRecord, PartRecord, UploadRecord }

export class MetadataStore {
  db: DatabaseSync
  readonly path: string
  private buckets: BucketMetadata
  private notifications: NotificationMetadata
  private objects: ObjectMetadata
  private multipart: MultipartMetadata

  constructor(path: string, { bucketCacheSize = 1024, configCacheSize = 4096, cacheTtlMs = 60000 } = {}) {
    this.path = path
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = FULL')
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.db.exec('PRAGMA foreign_keys = ON')

    const versionRow = this.db.prepare('PRAGMA user_version').get() as Record<string, number>
    const version = Number(versionRow['user_version'] ?? 0)
    if (version > SCHEMA_VERSION) {
      this.db.close()
      throw new Error(`metadata schema ${version} is newer than supported schema ${SCHEMA_VERSION}`)
    }

    this.db.exec('BEGIN IMMEDIATE')
    try {
      migrateV1ToV2(this.db)
      this.db.exec(SCHEMA)
      migrateV2ToV3(this.db)
      migrateV4ToV5(this.db)
      migrateV5ToV6(this.db)
      // Re-run after ALTER so new databases and upgrades converge on all current tables/indexes.
      this.db.exec(SCHEMA)
      this.db.exec(
        'UPDATE metadata_sequence SET value = MAX(value, (SELECT COALESCE(MAX(sequence), 0) FROM objects)) WHERE id = 1')
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
      this.db.exec('COMMIT')
    } catch (err) {
      try { this.db.exec('ROLLBACK') } catch { /* already rolled back */ }
      this.db.close()
      throw err
    }

    this.buckets = new BucketMetadata(this.db, { bucketCacheSize, configCacheSize, cacheTtlMs })
    this.notifications = new NotificationMetadata(this.db)
    this.objects = new ObjectMetadata(this.db)
    this.multipart = new MultipartMetadata(this.db)
  }

  close(): void {
    this.db.close()
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      faultPoint('metadata:after-commit')
      return result
    } catch (err) {
      try { this.db.exec('ROLLBACK') } catch { /* already rolled back */ }
      throw err
    }
  }

  // ── Buckets ──────────────────────────────────────────────────────────

  createBucket(name: string, region: string): void {
    this.buckets.createBucket(name, region)
  }

  getBucket(name: string): BucketRecord | null {
    return this.buckets.getBucket(name)
  }

  listBuckets(): BucketRecord[] {
    return this.buckets.listBuckets()
  }

  deleteBucket(name: string): void {
    this.objects.deleteAllInBucket(name)
    this.buckets.deleteBucketRow(name)
  }

  isBucketEmpty(name: string): boolean {
    return this.buckets.isBucketEmpty(name)
  }

  bucketUsage(bucket: string): { objects: number; bytes: number } {
    return this.buckets.bucketUsage(bucket)
  }

  getConfig<T = Record<string, unknown>>(bucket: string, name: string): T | null {
    return this.buckets.getConfig<T>(bucket, name)
  }

  putConfig(bucket: string, name: string, value: unknown): void {
    this.buckets.putConfig(bucket, name, value)
  }

  deleteConfig(bucket: string, name: string): void {
    this.buckets.deleteConfig(bucket, name)
  }

  bucketsWithConfig<T = Record<string, unknown>>(name: string): { bucket: string; value: T }[] {
    return this.buckets.bucketsWithConfig<T>(name)
  }

  // ── Notifications ────────────────────────────────────────────────────

  enqueueNotification(event: { bucket: string; targetId: string; endpoint: string; payload: string; now: number }): void {
    this.notifications.enqueueNotification(event)
  }

  claimDueNotifications(now: number, limit = 100, leaseMs = 30_000): NotificationQueueRow[] {
    return this.notifications.claimDueNotifications(now, limit, leaseMs)
  }

  rescheduleNotification(id: number, attempts: number, nextAttemptAt: number): void {
    this.notifications.rescheduleNotification(id, attempts, nextAttemptAt)
  }

  deadLetterNotification(id: number, attempts: number): void {
    this.notifications.deadLetterNotification(id, attempts)
  }

  deleteNotification(id: number): void {
    this.notifications.deleteNotification(id)
  }

  notificationQueueCounts(): Record<string, number> {
    const counts: Record<string, number> = { pending: 0, 'in-flight': 0, dead: 0 }
    for (const row of this.db.prepare(
      'SELECT status, count(*) AS total FROM notification_queue GROUP BY status').all() as { status: string; total: number }[]) {
      counts[row.status] = row.total
    }
    return counts
  }

  // ── Objects ──────────────────────────────────────────────────────────

  putObject(record: ObjectInput): void {
    this.objects.putObject(record)
  }

  /** Replaces the Object Lock state of one specific version. */
  setLock(bucket: string, key: string, versionId: string, lock: {
    retentionMode?: string | null
    retainUntil?: Date | null
    legalHold?: boolean
  }): void {
    this.objects.setLock(bucket, key, versionId, lock)
  }

  getObject(bucket: string, key: string, versionId?: string | null): ObjectRecord | null {
    return this.objects.getObject(bucket, key, versionId)
  }

  allVersionsOfKey(bucket: string, key: Buffer | string): ObjectRecord[] {
    return this.objects.allVersionsOfKey(bucket, key)
  }

  clearLatest(bucket: string, key: string): void {
    this.objects.clearLatest(bucket, key)
  }

  promoteLatest(bucket: string, key: string): void {
    this.objects.promoteLatest(bucket, key)
  }

  deleteVersion(bucket: string, key: string, versionId: string): boolean {
    return this.objects.deleteVersion(bucket, key, versionId)
  }

  setTags(bucket: string, key: string, versionId: string, tags: Record<string, string>): void {
    this.objects.setTags(bucket, key, versionId, tags)
  }

  blobsInBucket(bucket: string): string[] {
    return this.objects.blobsInBucket(bucket)
  }

  objectsModifiedBefore(bucket: string, cutoff: number): ObjectRecord[] {
    return this.objects.objectsModifiedBefore(bucket, cutoff)
  }

  listObjects(bucket: string, options?: {
    prefix?: string
    delimiter?: string
    maxKeys?: number
    startAfter?: string
    cursor?: Buffer | null
  }): ListObjectsResult {
    return this.objects.listObjects(bucket, options)
  }

  listVersions(bucket: string, options?: {
    prefix?: string
    delimiter?: string
    maxKeys?: number
    keyMarker?: string
    versionIdMarker?: string
  }): ListVersionsResult {
    return this.objects.listVersions(bucket, options)
  }

  // ── Multipart uploads ────────────────────────────────────────────────

  createUpload(input: Parameters<MultipartMetadata['createUpload']>[0]): void {
    this.multipart.createUpload(input)
  }

  getUpload(uploadId: string): UploadRecord | null {
    return this.multipart.getUpload(uploadId)
  }

  listUploads(bucket: string, maxUploads = 1000, keyMarker = '', uploadIdMarker: string | null = null): UploadRecord[] {
    return this.multipart.listUploads(bucket, maxUploads, keyMarker, uploadIdMarker)
  }

  uploadCount(bucket: string): number {
    return this.multipart.uploadCount(bucket)
  }

  uploadsStartedBefore(bucket: string, cutoff: number): UploadRecord[] {
    return this.multipart.uploadsStartedBefore(bucket, cutoff)
  }

  allStaleUploads(cutoff: number): UploadRecord[] {
    return this.multipart.allStaleUploads(cutoff)
  }

  /**
   * Returns every blobId referenced anywhere in the metadata store:
   * objects.blob_id, objects.parts (JSON), and upload_parts.blob_id.
   * Used by the garbage collector to distinguish live blobs from orphans.
   */
  allReferencedBlobIds(): Set<string> {
    const ids = new Set<string>()
    for (const id of this.objects.allBlobIds()) ids.add(id)
    for (const id of this.multipart.allUploadPartBlobIds()) ids.add(id)
    for (const row of this.db.prepare('SELECT blob_id FROM pending_blobs').all() as { blob_id: string }[]) {
      ids.add(row.blob_id)
    }
    return ids
  }

  reserveBlob(blobId: string): void {
    this.db.prepare('INSERT INTO pending_blobs (blob_id, created_at) VALUES (?, ?)').run(blobId, Date.now())
  }

  releasePendingBlob(blobId: string): void {
    this.db.prepare('DELETE FROM pending_blobs WHERE blob_id = ?').run(blobId)
  }

  releasePendingBlobsCreatedBefore(cutoff: number): number {
    return (this.db.prepare('DELETE FROM pending_blobs WHERE created_at < ?').run(cutoff) as { changes: number }).changes
  }

  putPart(input: Parameters<MultipartMetadata['putPart']>[0]): boolean {
    return this.multipart.putPart(input)
  }

  getPart(uploadId: string, partNumber: number): PartRecord | null {
    return this.multipart.getPart(uploadId, partNumber)
  }

  listParts(uploadId: string, options?: { partNumberMarker?: number; maxParts?: number }): PartRecord[] {
    return this.multipart.listParts(uploadId, options)
  }

  allParts(uploadId: string): PartRecord[] {
    return this.multipart.allParts(uploadId)
  }

  deleteUpload(uploadId: string): void {
    this.multipart.deleteUpload(uploadId)
  }
}
