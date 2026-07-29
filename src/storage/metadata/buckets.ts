import type { DatabaseSync } from 'node:sqlite'
import { LRUCache } from '../cache.js'
import type { BucketRecord, BucketRow, ConfigRow, CountRow, UsageRow } from './types.js'

interface BucketStatements {
  createBucket: ReturnType<DatabaseSync['prepare']>
  getBucket: ReturnType<DatabaseSync['prepare']>
  listBuckets: ReturnType<DatabaseSync['prepare']>
  deleteBucket: ReturnType<DatabaseSync['prepare']>
  countObjects: ReturnType<DatabaseSync['prepare']>
  bucketUsage: ReturnType<DatabaseSync['prepare']>
  getConfig: ReturnType<DatabaseSync['prepare']>
  putConfig: ReturnType<DatabaseSync['prepare']>
  deleteConfig: ReturnType<DatabaseSync['prepare']>
  deleteAllConfig: ReturnType<DatabaseSync['prepare']>
  bucketsWithConfig: ReturnType<DatabaseSync['prepare']>
}

/** Bucket CRUD, per-bucket usage aggregates, and the bucket-config KV store. */
export class BucketMetadata {
  private statements: BucketStatements
  private bucketCache: LRUCache<string, BucketRecord | null>
  private configCache: LRUCache<string, unknown>

  constructor(db: DatabaseSync, { bucketCacheSize = 1024, configCacheSize = 4096, cacheTtlMs = 60000 } = {}) {
    this.bucketCache = new LRUCache<string, BucketRecord | null>(bucketCacheSize, cacheTtlMs)
    this.configCache = new LRUCache<string, unknown>(configCacheSize, cacheTtlMs)

    this.statements = {
      createBucket: db.prepare('INSERT INTO buckets (name, created_at, region) VALUES (?, ?, ?)'),
      getBucket: db.prepare('SELECT name, created_at, region FROM buckets WHERE name = ?'),
      listBuckets: db.prepare('SELECT name, created_at, region FROM buckets ORDER BY name ASC'),
      deleteBucket: db.prepare('DELETE FROM buckets WHERE name = ?'),
      countObjects: db.prepare('SELECT count(*) AS total FROM objects WHERE bucket = ?'),
      bucketUsage: db.prepare(
        'SELECT count(*) AS objects, COALESCE(SUM(size), 0) AS bytes FROM objects ' +
        'WHERE bucket = ? AND is_latest = 1 AND is_delete_marker = 0'),
      getConfig: db.prepare('SELECT value FROM bucket_config WHERE bucket = ? AND name = ?'),
      putConfig: db.prepare(
        'INSERT INTO bucket_config (bucket, name, value) VALUES (?, ?, ?) ' +
        'ON CONFLICT (bucket, name) DO UPDATE SET value = excluded.value'),
      deleteConfig: db.prepare('DELETE FROM bucket_config WHERE bucket = ? AND name = ?'),
      deleteAllConfig: db.prepare('DELETE FROM bucket_config WHERE bucket = ?'),
      bucketsWithConfig: db.prepare('SELECT bucket, value FROM bucket_config WHERE name = ?'),
    }
  }

  createBucket(name: string, region: string): void {
    this.statements.createBucket.run(name, Date.now(), region)
    this.bucketCache.delete(name)
  }

  getBucket(name: string): BucketRecord | null {
    const cached = this.bucketCache.get(name)
    if (cached !== undefined) return cached
    const row = this.statements.getBucket.get(name) as unknown as BucketRow | undefined
    const result = row ? { name: row.name, createdAt: new Date(row.created_at), region: row.region } : null
    this.bucketCache.set(name, result)
    return result
  }

  listBuckets(): BucketRecord[] {
    return (this.statements.listBuckets.all() as unknown as BucketRow[])
      .map((row: BucketRow) => ({ name: row.name, createdAt: new Date(row.created_at), region: row.region }))
  }

  /** Removes the bucket row and its config; caller also clears object rows via ObjectMetadata. */
  deleteBucketRow(name: string): void {
    this.statements.deleteAllConfig.run(name)
    this.statements.deleteBucket.run(name)
    this.bucketCache.delete(name)
    this.configCache.clear()
  }

  isBucketEmpty(name: string): boolean {
    return (this.statements.countObjects.get(name) as unknown as CountRow).total === 0
  }

  /** Current (non-delete-marker) object count and total byte size for a bucket, for quota checks. */
  bucketUsage(bucket: string): { objects: number; bytes: number } {
    const row = this.statements.bucketUsage.get(bucket) as unknown as UsageRow
    return { objects: row.objects, bytes: row.bytes }
  }

  /**
   * Config documents are stored as opaque JSON. The caller names the shape it
   * expects, because only the caller knows which parser produced the document.
   */
  getConfig<T = Record<string, unknown>>(bucket: string, name: string): T | null {
    const cacheKey = `${bucket}\x00${name}`
    const cached = this.configCache.get(cacheKey) as T | null | undefined
    if (cached !== undefined) return cached as T | null
    const row = this.statements.getConfig.get(bucket, name) as unknown as ConfigRow | undefined
    const result = row ? JSON.parse(row.value) as T : null
    this.configCache.set(cacheKey, result)
    return result
  }

  putConfig(bucket: string, name: string, value: unknown): void {
    this.statements.putConfig.run(bucket, name, JSON.stringify(value))
    this.configCache.set(`${bucket}\x00${name}`, value)
  }

  deleteConfig(bucket: string, name: string): void {
    this.statements.deleteConfig.run(bucket, name)
    this.configCache.delete(`${bucket}\x00${name}`)
  }

  bucketsWithConfig<T = Record<string, unknown>>(name: string): { bucket: string; value: T }[] {
    return (this.statements.bucketsWithConfig.all(name) as { bucket: string; value: string }[])
      .map((row) => ({ bucket: row.bucket, value: JSON.parse(row.value) as T }))
  }
}
