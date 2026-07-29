import { DatabaseSync } from 'node:sqlite'
import type { EncryptionContext } from '../features/encryption.js'
import { keySuccessor, prefixUpperBound, toKeyBuffer } from '../util/bytes.js'
import type { BlobPart } from './blobs.js'
import { LRUCache } from './cache.js'

export const SCHEMA_VERSION = 3
export const NULL_VERSION = 'null'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS buckets (
  name          TEXT PRIMARY KEY,
  created_at    INTEGER NOT NULL,
  region        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bucket_config (
  bucket        TEXT NOT NULL,
  name          TEXT NOT NULL,
  value         TEXT NOT NULL,
  PRIMARY KEY (bucket, name)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS objects (
  bucket           TEXT NOT NULL,
  key              BLOB NOT NULL,
  version_id       TEXT NOT NULL,
  sequence         INTEGER NOT NULL,
  is_latest        INTEGER NOT NULL DEFAULT 1,
  is_delete_marker INTEGER NOT NULL DEFAULT 0,
  size             INTEGER NOT NULL,
  etag             TEXT NOT NULL,
  content_type     TEXT,
  last_modified    INTEGER NOT NULL,
  blob_id          TEXT,
  parts            TEXT,
  metadata         TEXT,
  checksums        TEXT,
  tags             TEXT,
  encryption       TEXT,
  retention_mode   TEXT,
  retain_until     INTEGER,
  legal_hold       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, key, version_id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS objects_latest ON objects (bucket, key) WHERE is_latest = 1;
CREATE INDEX IF NOT EXISTS objects_sequence ON objects (bucket, key, sequence DESC);

CREATE TABLE IF NOT EXISTS uploads (
  upload_id     TEXT PRIMARY KEY,
  bucket        TEXT NOT NULL,
  key           BLOB NOT NULL,
  initiated_at  INTEGER NOT NULL,
  content_type  TEXT,
  metadata      TEXT,
  tags          TEXT,
  encryption    TEXT
);

CREATE INDEX IF NOT EXISTS uploads_by_bucket_key ON uploads (bucket, key);

CREATE TABLE IF NOT EXISTS upload_parts (
  upload_id     TEXT NOT NULL,
  part_number   INTEGER NOT NULL,
  size          INTEGER NOT NULL,
  etag          TEXT NOT NULL,
  blob_id       TEXT NOT NULL,
  uploaded_at   INTEGER NOT NULL,
  PRIMARY KEY (upload_id, part_number)
) WITHOUT ROWID;
`

const LIST_BATCH = 512

export interface ObjectRecord {
  bucket: string
  key: Buffer
  versionId: string
  sequence: number
  isLatest: boolean
  isDeleteMarker: boolean
  size: number
  etag: string
  contentType: string | undefined
  lastModified: Date
  blobId: string | null
  parts: BlobPart[] | null
  metadata: Record<string, string>
  checksums: Record<string, string>
  tags: Record<string, string>
  encryption: EncryptionContext | null
  /** Object Lock: retention mode, its expiry, and the independent legal hold. */
  retentionMode: string | null
  retainUntil: Date | null
  legalHold: boolean
}

export interface BucketRecord {
  name: string
  createdAt: Date
  region: string
}

export interface UploadRecord {
  uploadId: string
  bucket: string
  key: Buffer
  initiatedAt: Date
  contentType: string | undefined
  metadata: Record<string, string>
  tags: Record<string, string>
  encryption: EncryptionContext | null
}

export interface PartRecord {
  partNumber: number
  size: number
  etag: string
  blobId: string
  uploadedAt?: Date
}

interface RawRow {
  bucket: string
  key: Buffer
  version_id: string
  sequence: number
  is_latest: number
  is_delete_marker: number
  size: number
  etag: string
  content_type: string | null
  last_modified: number
  blob_id: string | null
  parts: string | null
  metadata: string | null
  checksums: string | null
  tags: string | null
  encryption: string | null
  retention_mode: string | null
  retain_until: number | null
  legal_hold: number
}

function decodeRow(row: RawRow | undefined): ObjectRecord | null {
  if (!row) return null
  return {
    bucket: row.bucket,
    key: Buffer.from(row.key),
    versionId: row.version_id,
    sequence: row.sequence,
    isLatest: row.is_latest === 1,
    isDeleteMarker: row.is_delete_marker === 1,
    size: row.size,
    etag: row.etag,
    contentType: row.content_type ?? undefined,
    lastModified: new Date(row.last_modified),
    blobId: row.blob_id ?? null,
    parts: row.parts ? JSON.parse(row.parts) : null,
    metadata: row.metadata ? JSON.parse(row.metadata) : {},
    checksums: row.checksums ? JSON.parse(row.checksums) : {},
    tags: row.tags ? JSON.parse(row.tags) : {},
    encryption: row.encryption ? JSON.parse(row.encryption) : null,
    retentionMode: (row.retention_mode as string | null) ?? null,
    retainUntil: row.retain_until == null ? null : new Date(Number(row.retain_until)),
    legalHold: Boolean(row.legal_hold),
  }
}

/** Object Lock columns arrived in v3; they are nullable, so ALTER is enough. */
function migrateV2ToV3(db: DatabaseSync): void {
  const columns = db.prepare('PRAGMA table_info(objects)').all().map((c: Record<string, unknown>) => c.name)
  if (columns.length === 0 || columns.includes('retention_mode')) return
  db.exec('ALTER TABLE objects ADD COLUMN retention_mode TEXT')
  db.exec('ALTER TABLE objects ADD COLUMN retain_until INTEGER')
  db.exec('ALTER TABLE objects ADD COLUMN legal_hold INTEGER NOT NULL DEFAULT 0')
}

function migrateV1ToV2(db: DatabaseSync): void {
  const columns = db.prepare('PRAGMA table_info(objects)').all().map((c: Record<string, unknown>) => c.name)
  if (columns.length === 0 || columns.includes('version_id')) return
  db.exec('ALTER TABLE objects RENAME TO objects_v1')
  db.exec(SCHEMA)
  db.exec(`
    INSERT INTO objects (bucket, key, version_id, sequence, is_latest, is_delete_marker,
                         size, etag, content_type, last_modified, blob_id, parts, metadata, checksums)
    SELECT bucket, key, 'null', last_modified, 1, 0,
           size, etag, content_type, last_modified, blob_id, parts, metadata, checksums
      FROM objects_v1`)
  db.exec('DROP TABLE objects_v1')
}

export interface ObjectInput {
  bucket: string
  key: string
  versionId?: string
  sequence?: number
  isLatest?: boolean
  isDeleteMarker?: boolean
  size: number
  etag: string
  contentType?: string
  lastModified: Date | number
  blobId?: string | null
  parts?: BlobPart[] | null
  metadata?: Record<string, string>
  checksums?: Record<string, string>
  tags?: Record<string, string>
  encryption?: EncryptionContext | null
  retentionMode?: string | null
  retainUntil?: Date | null
  legalHold?: boolean
}

interface ConfigRow {
  value: string
}

interface BucketRow {
  name: string
  created_at: number
  region: string
}

interface CountRow {
  total: number
}

interface MaxSeqRow {
  value: number
}

interface PartRow {
  part_number: number
  size: number
  etag: string
  blob_id: string
  uploaded_at: number
}

interface UploadRow {
  upload_id: string
  bucket: string
  key: Buffer
  initiated_at: number
  content_type: string | null
  metadata: string | null
  tags: string | null
  encryption: string | null
}

export interface ListObjectsResult {
  contents: ObjectRecord[]
  commonPrefixes: string[]
  truncated: boolean
  nextCursor: Buffer | null
}

export interface ListVersionsResult {
  versions: ObjectRecord[]
  commonPrefixes: string[]
  truncated: boolean
  nextKeyMarker: string | null
  nextVersionIdMarker: string | null
}

export class MetadataStore {
  db: DatabaseSync
  statements: Record<string, ReturnType<DatabaseSync['prepare']>>
  _sequence: number
  private bucketCache: LRUCache<string, BucketRecord | null>
  private configCache: LRUCache<string, unknown>

  constructor(path: string, { bucketCacheSize = 1024, configCacheSize = 4096, cacheTtlMs = 60000 } = {}) {
    this.bucketCache = new LRUCache<string, BucketRecord | null>(bucketCacheSize, cacheTtlMs)
    this.configCache = new LRUCache<string, unknown>(configCacheSize, cacheTtlMs)
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.db.exec('PRAGMA foreign_keys = ON')

    migrateV1ToV2(this.db)
    this.db.exec(SCHEMA)
    migrateV2ToV3(this.db)
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)

    this.statements = {
      createBucket: this.db.prepare('INSERT INTO buckets (name, created_at, region) VALUES (?, ?, ?)'),
      getBucket: this.db.prepare('SELECT name, created_at, region FROM buckets WHERE name = ?'),
      listBuckets: this.db.prepare('SELECT name, created_at, region FROM buckets ORDER BY name ASC'),
      deleteBucket: this.db.prepare('DELETE FROM buckets WHERE name = ?'),
      countObjects: this.db.prepare('SELECT count(*) AS total FROM objects WHERE bucket = ?'),

      getConfig: this.db.prepare('SELECT value FROM bucket_config WHERE bucket = ? AND name = ?'),
      putConfig: this.db.prepare(
        'INSERT INTO bucket_config (bucket, name, value) VALUES (?, ?, ?) ' +
        'ON CONFLICT (bucket, name) DO UPDATE SET value = excluded.value'),
      deleteConfig: this.db.prepare('DELETE FROM bucket_config WHERE bucket = ? AND name = ?'),
      deleteAllConfig: this.db.prepare('DELETE FROM bucket_config WHERE bucket = ?'),
      bucketsWithConfig: this.db.prepare('SELECT bucket, value FROM bucket_config WHERE name = ?'),

      putObject: this.db.prepare(`
        INSERT INTO objects (bucket, key, version_id, sequence, is_latest, is_delete_marker,
                             size, etag, content_type, last_modified, blob_id, parts,
                             metadata, checksums, tags, encryption,
                             retention_mode, retain_until, legal_hold)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (bucket, key, version_id) DO UPDATE SET
          sequence = excluded.sequence, is_latest = excluded.is_latest,
          is_delete_marker = excluded.is_delete_marker, size = excluded.size,
          etag = excluded.etag, content_type = excluded.content_type,
          last_modified = excluded.last_modified, blob_id = excluded.blob_id,
          parts = excluded.parts, metadata = excluded.metadata,
          checksums = excluded.checksums, tags = excluded.tags, encryption = excluded.encryption,
          retention_mode = excluded.retention_mode, retain_until = excluded.retain_until,
          legal_hold = excluded.legal_hold`),
      updateLock: this.db.prepare(
        'UPDATE objects SET retention_mode = ?, retain_until = ?, legal_hold = ? ' +
        ' WHERE bucket = ? AND key = ? AND version_id = ?'),
      getVersion: this.db.prepare('SELECT * FROM objects WHERE bucket = ? AND key = ? AND version_id = ?'),
      getLatest: this.db.prepare(
        'SELECT * FROM objects WHERE bucket = ? AND key = ? AND is_latest = 1'),
      allVersionsOfKey: this.db.prepare(
        'SELECT * FROM objects WHERE bucket = ? AND key = ? ORDER BY sequence DESC'),
      clearLatest: this.db.prepare(
        'UPDATE objects SET is_latest = 0 WHERE bucket = ? AND key = ? AND is_latest = 1'),
      promoteLatest: this.db.prepare(`
        UPDATE objects SET is_latest = 1
         WHERE bucket = ? AND key = ? AND version_id = (
           SELECT version_id FROM objects WHERE bucket = ? AND key = ?
            ORDER BY sequence DESC LIMIT 1)`),
      deleteVersion: this.db.prepare(
        'DELETE FROM objects WHERE bucket = ? AND key = ? AND version_id = ?'),
      updateTags: this.db.prepare(
        'UPDATE objects SET tags = ? WHERE bucket = ? AND key = ? AND version_id = ?'),
      maxSequence: this.db.prepare('SELECT IFNULL(MAX(sequence), 0) AS value FROM objects'),

      scanLatest: this.db.prepare(`
        SELECT * FROM objects
         WHERE bucket = ? AND key >= ? AND is_latest = 1 AND is_delete_marker = 0
         ORDER BY key ASC LIMIT ?`),
      scanLatestRange: this.db.prepare(`
        SELECT * FROM objects
         WHERE bucket = ? AND key >= ? AND key < ? AND is_latest = 1 AND is_delete_marker = 0
         ORDER BY key ASC LIMIT ?`),
      scanVersions: this.db.prepare(`
        SELECT * FROM objects
         WHERE bucket = ? AND (key > ? OR (key = ? AND sequence < ?))
         ORDER BY key ASC, sequence DESC LIMIT ?`),
      scanVersionsRange: this.db.prepare(`
        SELECT * FROM objects
         WHERE bucket = ? AND (key > ? OR (key = ? AND sequence < ?)) AND key < ?
         ORDER BY key ASC, sequence DESC LIMIT ?`),
      allObjects: this.db.prepare('SELECT blob_id, parts FROM objects WHERE bucket = ?'),
      allBlobIds: this.db.prepare('SELECT blob_id FROM objects WHERE blob_id IS NOT NULL'),
      allPartsBlobIds: this.db.prepare('SELECT parts FROM objects WHERE parts IS NOT NULL'),
      allUploadPartBlobIds: this.db.prepare('SELECT blob_id FROM upload_parts'),
      deleteAllObjects: this.db.prepare('DELETE FROM objects WHERE bucket = ?'),
      expiredObjects: this.db.prepare(`
        SELECT * FROM objects WHERE bucket = ? AND last_modified < ? ORDER BY key ASC`),

      createUpload: this.db.prepare(
        'INSERT INTO uploads (upload_id, bucket, key, initiated_at, content_type, metadata, tags, encryption) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
      getUpload: this.db.prepare('SELECT * FROM uploads WHERE upload_id = ?'),
      deleteUpload: this.db.prepare('DELETE FROM uploads WHERE upload_id = ?'),
      listUploads: this.db.prepare(
        'SELECT * FROM uploads WHERE bucket = ? ORDER BY key ASC, upload_id ASC LIMIT ?'),
      countUploads: this.db.prepare('SELECT count(*) AS total FROM uploads WHERE bucket = ?'),
      staleUploads: this.db.prepare('SELECT * FROM uploads WHERE bucket = ? AND initiated_at < ?'),
      staleUploadsGlobal: this.db.prepare('SELECT * FROM uploads WHERE initiated_at < ?'),

      putPart: this.db.prepare(`
        INSERT INTO upload_parts (upload_id, part_number, size, etag, blob_id, uploaded_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (upload_id, part_number) DO UPDATE SET
          size = excluded.size, etag = excluded.etag,
          blob_id = excluded.blob_id, uploaded_at = excluded.uploaded_at`),
      getPart: this.db.prepare('SELECT * FROM upload_parts WHERE upload_id = ? AND part_number = ?'),
      listParts: this.db.prepare(
        'SELECT * FROM upload_parts WHERE upload_id = ? AND part_number > ? ORDER BY part_number ASC LIMIT ?'),
      allParts: this.db.prepare('SELECT * FROM upload_parts WHERE upload_id = ? ORDER BY part_number ASC'),
      deleteParts: this.db.prepare('DELETE FROM upload_parts WHERE upload_id = ?'),
    }

    this._sequence = (this.statements.maxSequence.get() as unknown as MaxSeqRow).value
  }

  close(): void {
    this.db.close()
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (err) {
      try { this.db.exec('ROLLBACK') } catch { /* already rolled back */ }
      throw err
    }
  }

  nextSequence(): number {
    this._sequence = Math.max(this._sequence + 1, Date.now())
    return this._sequence
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

  deleteBucket(name: string): void {
    this.statements.deleteAllConfig.run(name)
    this.statements.deleteAllObjects.run(name)
    this.statements.deleteBucket.run(name)
    this.bucketCache.delete(name)
    this.configCache.clear()
  }

  isBucketEmpty(name: string): boolean {
    return (this.statements.countObjects.get(name) as unknown as CountRow).total === 0
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

  putObject(record: ObjectInput): void {
    this.statements.putObject.run(
      record.bucket,
      toKeyBuffer(record.key),
      record.versionId ?? NULL_VERSION,
      record.sequence ?? this.nextSequence(),
      record.isLatest === false ? 0 : 1,
      record.isDeleteMarker ? 1 : 0,
      record.size,
      record.etag,
      record.contentType ?? null,
      record.lastModified instanceof Date ? record.lastModified.getTime() : record.lastModified,
      record.blobId ?? null,
      record.parts ? JSON.stringify(record.parts) : null,
      record.metadata && Object.keys(record.metadata).length ? JSON.stringify(record.metadata) : null,
      record.checksums && Object.keys(record.checksums).length ? JSON.stringify(record.checksums) : null,
      record.tags && Object.keys(record.tags).length ? JSON.stringify(record.tags) : null,
      record.encryption ? JSON.stringify(record.encryption) : null,
      record.retentionMode ?? null,
      record.retainUntil ? record.retainUntil.getTime() : null,
      record.legalHold ? 1 : 0,
    )
  }

  /** Replaces the Object Lock state of one specific version. */
  setLock(bucket: string, key: string, versionId: string, lock: {
    retentionMode?: string | null
    retainUntil?: Date | null
    legalHold?: boolean
  }): void {
    this.statements.updateLock.run(
      lock.retentionMode ?? null,
      lock.retainUntil ? lock.retainUntil.getTime() : null,
      lock.legalHold ? 1 : 0,
      bucket,
      toKeyBuffer(key),
      versionId,
    )
  }

  getObject(bucket: string, key: string, versionId?: string | null): ObjectRecord | null {
    const row = versionId
      ? (this.statements.getVersion.get(bucket, toKeyBuffer(key), versionId) as unknown as RawRow | undefined)
      : (this.statements.getLatest.get(bucket, toKeyBuffer(key)) as unknown as RawRow | undefined)
    return decodeRow(row)
  }

  allVersionsOfKey(bucket: string, key: Buffer | string): ObjectRecord[] {
    return (this.statements.allVersionsOfKey.all(bucket, toKeyBuffer(key)) as unknown as RawRow[]).map(decodeRow).filter((r): r is ObjectRecord => r !== null)
  }

  clearLatest(bucket: string, key: string): void {
    this.statements.clearLatest.run(bucket, toKeyBuffer(key))
  }

  promoteLatest(bucket: string, key: string): void {
    const keyBuffer = toKeyBuffer(key)
    this.statements.promoteLatest.run(bucket, keyBuffer, bucket, keyBuffer)
  }

  deleteVersion(bucket: string, key: string, versionId: string): boolean {
    return (this.statements.deleteVersion.run(bucket, toKeyBuffer(key), versionId) as { changes: number }).changes > 0
  }

  setTags(bucket: string, key: string, versionId: string, tags: Record<string, string>): void {
    this.statements.updateTags.run(
      tags && Object.keys(tags).length ? JSON.stringify(tags) : null,
      bucket, toKeyBuffer(key), versionId,
    )
  }

  blobsInBucket(bucket: string): string[] {
    const ids: string[] = []
    for (const row of this.statements.allObjects.all(bucket) as { blob_id: string | null; parts: string | null }[]) {
      if (row.blob_id) ids.push(row.blob_id)
      if (row.parts) for (const part of JSON.parse(row.parts) as { blobId: string }[]) ids.push(part.blobId)
    }
    return ids
  }

  objectsModifiedBefore(bucket: string, cutoff: number): ObjectRecord[] {
    return (this.statements.expiredObjects.all(bucket, cutoff) as unknown as RawRow[]).map(decodeRow).filter((r): r is ObjectRecord => r !== null)
  }

  private _scan(bucket: string, cursor: Buffer, upperBound: Buffer | null, limit: number): RawRow[] {
    return upperBound
      ? (this.statements.scanLatestRange.all(bucket, cursor, upperBound, limit) as unknown as RawRow[])
      : (this.statements.scanLatest.all(bucket, cursor, limit) as unknown as RawRow[])
  }

  listObjects(bucket: string, {
    prefix = '', delimiter = '', maxKeys = 1000, startAfter = '', cursor: resumeCursor = null,
  }: {
    prefix?: string
    delimiter?: string
    maxKeys?: number
    startAfter?: string
    cursor?: Buffer | null
  } = {}): ListObjectsResult {
    const prefixBuf = toKeyBuffer(prefix)
    const delimiterBuf = delimiter ? toKeyBuffer(delimiter) : null
    const upperBound = prefixUpperBound(prefixBuf)

    let cursor = prefixBuf
    if (resumeCursor && Buffer.compare(resumeCursor, cursor) > 0) cursor = resumeCursor
    if (startAfter) {
      const startAfterBuf = keySuccessor(startAfter)
      if (Buffer.compare(startAfterBuf, cursor) > 0) cursor = startAfterBuf
    }

    const contents: ObjectRecord[] = []
    const commonPrefixes: string[] = []
    const seenPrefixes = new Set<string>()
    let truncated = false
    let nextCursor: Buffer | null = null

    outer: while (contents.length + commonPrefixes.length < maxKeys) {
      const rows = this._scan(bucket, cursor, upperBound, LIST_BATCH)
      if (rows.length === 0) break

      for (const row of rows) {
        const key = Buffer.from(row.key)

        if (delimiterBuf) {
          const tail = key.subarray(prefixBuf.length)
          const at = tail.indexOf(delimiterBuf)
          if (at !== -1) {
            const groupPrefix = key.subarray(0, prefixBuf.length + at + delimiterBuf.length)
            const groupKey = groupPrefix.toString('utf8')
            if (!seenPrefixes.has(groupKey)) {
              if (contents.length + commonPrefixes.length >= maxKeys) {
                truncated = true
                nextCursor = cursor
                break outer
              }
              seenPrefixes.add(groupKey)
              commonPrefixes.push(groupKey)
            }
            const bound = prefixUpperBound(groupPrefix)
            if (!bound) { cursor = null as unknown as Buffer; break outer }
            cursor = bound
            continue outer
          }
        }

        if (contents.length + commonPrefixes.length >= maxKeys) {
          truncated = true
          nextCursor = cursor
          break outer
        }
        const record = decodeRow(row)
        if (record) contents.push(record)
        cursor = keySuccessor(key)
      }

      if (rows.length < LIST_BATCH) break
    }

    if (!truncated && cursor && contents.length + commonPrefixes.length >= maxKeys) {
      truncated = this._scan(bucket, cursor, upperBound, 1).length > 0
      if (truncated) nextCursor = cursor
    }

    return {
      contents,
      commonPrefixes,
      truncated,
      nextCursor: truncated ? nextCursor ?? cursor : null,
    }
  }

  listVersions(bucket: string, {
    prefix = '', delimiter = '', maxKeys = 1000, keyMarker = '', versionIdMarker = '',
  }: {
    prefix?: string
    delimiter?: string
    maxKeys?: number
    keyMarker?: string
    versionIdMarker?: string
  } = {}): ListVersionsResult {
    const prefixBuf = toKeyBuffer(prefix)
    const delimiterBuf = delimiter ? toKeyBuffer(delimiter) : null
    const upperBound = prefixUpperBound(prefixBuf)

    let cursorKey = prefixBuf
    let cursorSequence = Number.MAX_SAFE_INTEGER
    if (keyMarker) {
      const markerKey = toKeyBuffer(keyMarker)
      if (Buffer.compare(markerKey, cursorKey) >= 0) {
        cursorKey = markerKey
        cursorSequence = Number.MIN_SAFE_INTEGER
        if (versionIdMarker) {
          const row = this.statements.getVersion.get(bucket, markerKey, versionIdMarker) as unknown as RawRow | undefined
          if (row) cursorSequence = row.sequence
        }
      }
    }

    const scan = (limit: number): RawRow[] => (upperBound
      ? (this.statements.scanVersionsRange.all(bucket, cursorKey, cursorKey, cursorSequence, upperBound, limit) as unknown as RawRow[])
      : (this.statements.scanVersions.all(bucket, cursorKey, cursorKey, cursorSequence, limit) as unknown as RawRow[]))

    const versions: ObjectRecord[] = []
    const commonPrefixes: string[] = []
    const seenPrefixes = new Set<string>()
    let truncated = false
    let nextKeyMarker: string | null = null
    let nextVersionIdMarker: string | null = null

    outer: while (versions.length + commonPrefixes.length < maxKeys) {
      const rows = scan(LIST_BATCH)
      if (rows.length === 0) break

      for (const row of rows) {
        const key = Buffer.from(row.key)

        if (delimiterBuf) {
          const tail = key.subarray(prefixBuf.length)
          const at = tail.indexOf(delimiterBuf)
          if (at !== -1) {
            const groupPrefix = key.subarray(0, prefixBuf.length + at + delimiterBuf.length)
            const groupKey = groupPrefix.toString('utf8')
            if (!seenPrefixes.has(groupKey)) {
              if (versions.length + commonPrefixes.length >= maxKeys) {
                truncated = true
                break outer
              }
              seenPrefixes.add(groupKey)
              commonPrefixes.push(groupKey)
            }
            const bound = prefixUpperBound(groupPrefix)
            if (!bound) break outer
            cursorKey = bound
            cursorSequence = Number.MAX_SAFE_INTEGER
            continue outer
          }
        }

        if (versions.length + commonPrefixes.length >= maxKeys) {
          truncated = true
          break outer
        }
        const record = decodeRow(row)
        if (record) versions.push(record)
        cursorKey = key
        cursorSequence = row.sequence
        nextKeyMarker = key.toString('utf8')
        nextVersionIdMarker = record?.versionId ?? null
      }

      if (rows.length < LIST_BATCH) break
    }

    if (!truncated && versions.length + commonPrefixes.length >= maxKeys) {
      truncated = scan(1).length > 0
    }

    return {
      versions,
      commonPrefixes,
      truncated,
      nextKeyMarker: truncated ? nextKeyMarker : null,
      nextVersionIdMarker: truncated ? nextVersionIdMarker : null,
    }
  }

  createUpload({ uploadId, bucket, key, contentType, metadata, tags, encryption }: {
    uploadId: string
    bucket: string
    key: string
    contentType?: string
    metadata?: Record<string, string>
    tags?: Record<string, string>
    encryption?: EncryptionContext | null
  }): void {
    this.statements.createUpload.run(
      uploadId, bucket, toKeyBuffer(key), Date.now(),
      contentType ?? null,
      metadata && Object.keys(metadata).length ? JSON.stringify(metadata) : null,
      tags && Object.keys(tags).length ? JSON.stringify(tags) : null,
      encryption ? JSON.stringify(encryption) : null,
    )
  }

  private _decodeUpload(row: UploadRow | undefined): UploadRecord | null {
    if (!row) return null
    return {
      uploadId: row.upload_id,
      bucket: row.bucket,
      key: Buffer.from(row.key),
      initiatedAt: new Date(row.initiated_at),
      contentType: row.content_type ?? undefined,
      metadata: row.metadata ? JSON.parse(row.metadata) : {},
      tags: row.tags ? JSON.parse(row.tags) : {},
      encryption: row.encryption ? JSON.parse(row.encryption) : null,
    }
  }

  getUpload(uploadId: string): UploadRecord | null {
    return this._decodeUpload(this.statements.getUpload.get(uploadId) as unknown as UploadRow | undefined)
  }

  listUploads(bucket: string, maxUploads = 1000): UploadRecord[] {
    return (this.statements.listUploads.all(bucket, maxUploads) as unknown as UploadRow[])
      .map((row) => this._decodeUpload(row))
      .filter((u): u is UploadRecord => u !== null)
  }

  uploadCount(bucket: string): number {
    return (this.statements.countUploads.get(bucket) as unknown as CountRow).total
  }

  uploadsStartedBefore(bucket: string, cutoff: number): UploadRecord[] {
    return (this.statements.staleUploads.all(bucket, cutoff) as unknown as UploadRow[])
      .map((row) => this._decodeUpload(row))
      .filter((u): u is UploadRecord => u !== null)
  }

  allStaleUploads(cutoff: number): UploadRecord[] {
    return (this.statements.staleUploadsGlobal.all(cutoff) as unknown as UploadRow[])
      .map((row) => this._decodeUpload(row))
      .filter((u): u is UploadRecord => u !== null)
  }

  /**
   * Returns every blobId referenced anywhere in the metadata store:
   * objects.blob_id, objects.parts (JSON), and upload_parts.blob_id.
   * Used by the garbage collector to distinguish live blobs from orphans.
   */
  allReferencedBlobIds(): Set<string> {
    const ids = new Set<string>()
    for (const row of this.statements.allBlobIds.all() as { blob_id: string }[]) {
      ids.add(row.blob_id)
    }
    for (const row of this.statements.allPartsBlobIds.all() as { parts: string }[]) {
      try {
        for (const part of JSON.parse(row.parts) as { blobId: string }[]) {
          if (part.blobId) ids.add(part.blobId)
        }
      } catch { /* skip malformed parts JSON */ }
    }
    for (const row of this.statements.allUploadPartBlobIds.all() as { blob_id: string }[]) {
      ids.add(row.blob_id)
    }
    return ids
  }

  putPart({ uploadId, partNumber, size, etag, blobId }: {
    uploadId: string
    partNumber: number
    size: number
    etag: string
    blobId: string
  }): void {
    this.statements.putPart.run(uploadId, partNumber, size, etag, blobId, Date.now())
  }

  getPart(uploadId: string, partNumber: number): PartRecord | null {
    const row = this.statements.getPart.get(uploadId, partNumber) as unknown as PartRow | undefined
    return row
      ? { partNumber: row.part_number, size: row.size, etag: row.etag, blobId: row.blob_id, uploadedAt: new Date(row.uploaded_at) }
      : null
  }

  listParts(uploadId: string, { partNumberMarker = 0, maxParts = 1000 } = {}): PartRecord[] {
    return (this.statements.listParts.all(uploadId, partNumberMarker, maxParts) as unknown as PartRow[]).map((row) => ({
      partNumber: row.part_number,
      size: row.size,
      etag: row.etag,
      blobId: row.blob_id,
      uploadedAt: new Date(row.uploaded_at),
    }))
  }

  allParts(uploadId: string): PartRecord[] {
    return (this.statements.allParts.all(uploadId) as unknown as PartRow[]).map((row) => ({
      partNumber: row.part_number,
      size: row.size,
      etag: row.etag,
      blobId: row.blob_id,
    }))
  }

  deleteUpload(uploadId: string): void {
    this.statements.deleteParts.run(uploadId)
    this.statements.deleteUpload.run(uploadId)
  }
}
