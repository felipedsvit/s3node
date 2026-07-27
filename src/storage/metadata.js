import { DatabaseSync } from 'node:sqlite'
import { keySuccessor, prefixUpperBound, toKeyBuffer } from '../util/bytes.js'

export const SCHEMA_VERSION = 2

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
  PRIMARY KEY (bucket, key, version_id)
) WITHOUT ROWID;

-- Current-version listings are the hot path; the partial index keeps them from
-- walking historical versions.
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

function decodeRow(row) {
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
  }
}

/**
 * Rebuilds a v1 `objects` table into the versioned v2 shape. SQLite cannot
 * change a primary key in place, so the table is recreated and copied with
 * every existing row becoming the `null` version.
 */
function migrateV1ToV2(db) {
  const columns = db.prepare('PRAGMA table_info(objects)').all().map((c) => c.name)
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

/**
 * Metadata lives in SQLite because ListObjectsV2 is an ordered range scan.
 * A filesystem walk is unordered and O(n) over the whole bucket; the primary
 * key index makes it O(log n + k). Storing the key as BLOB additionally gives
 * byte-wise ordering for free (docs/plan.md section 8).
 */
export class MetadataStore {
  constructor(path) {
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.db.exec('PRAGMA foreign_keys = ON')

    migrateV1ToV2(this.db)
    this.db.exec(SCHEMA)
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
                             metadata, checksums, tags, encryption)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (bucket, key, version_id) DO UPDATE SET
          sequence = excluded.sequence, is_latest = excluded.is_latest,
          is_delete_marker = excluded.is_delete_marker, size = excluded.size,
          etag = excluded.etag, content_type = excluded.content_type,
          last_modified = excluded.last_modified, blob_id = excluded.blob_id,
          parts = excluded.parts, metadata = excluded.metadata,
          checksums = excluded.checksums, tags = excluded.tags, encryption = excluded.encryption`),
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
      // Version listings page on (key, sequence): a batch boundary may land in
      // the middle of one key's versions, so a key-only cursor would drop the
      // remainder of that key.
      scanVersions: this.db.prepare(`
        SELECT * FROM objects
         WHERE bucket = ? AND (key > ? OR (key = ? AND sequence < ?))
         ORDER BY key ASC, sequence DESC LIMIT ?`),
      scanVersionsRange: this.db.prepare(`
        SELECT * FROM objects
         WHERE bucket = ? AND (key > ? OR (key = ? AND sequence < ?)) AND key < ?
         ORDER BY key ASC, sequence DESC LIMIT ?`),
      allObjects: this.db.prepare('SELECT blob_id, parts FROM objects WHERE bucket = ?'),
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
      staleUploads: this.db.prepare('SELECT * FROM uploads WHERE bucket = ? AND initiated_at < ?'),

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

    this._sequence = this.statements.maxSequence.get().value
  }

  close() {
    this.db.close()
  }

  transaction(fn) {
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

  /** Monotonic and roughly time-ordered; used to order versions newest-first. */
  nextSequence() {
    this._sequence = Math.max(this._sequence + 1, Date.now())
    return this._sequence
  }

  /* ---------------------------- buckets ---------------------------- */

  createBucket(name, region) {
    this.statements.createBucket.run(name, Date.now(), region)
  }

  getBucket(name) {
    const row = this.statements.getBucket.get(name)
    return row ? { name: row.name, createdAt: new Date(row.created_at), region: row.region } : null
  }

  listBuckets() {
    return this.statements.listBuckets.all()
      .map((row) => ({ name: row.name, createdAt: new Date(row.created_at), region: row.region }))
  }

  deleteBucket(name) {
    this.statements.deleteAllConfig.run(name)
    this.statements.deleteAllObjects.run(name)
    this.statements.deleteBucket.run(name)
  }

  isBucketEmpty(name) {
    return this.statements.countObjects.get(name).total === 0
  }

  /* ------------------------ bucket subresources -------------------- */

  getConfig(bucket, name) {
    const row = this.statements.getConfig.get(bucket, name)
    return row ? JSON.parse(row.value) : null
  }

  putConfig(bucket, name, value) {
    this.statements.putConfig.run(bucket, name, JSON.stringify(value))
  }

  deleteConfig(bucket, name) {
    this.statements.deleteConfig.run(bucket, name)
  }

  /** Every bucket carrying a given configuration, for background sweeps. */
  bucketsWithConfig(name) {
    return this.statements.bucketsWithConfig.all(name)
      .map((row) => ({ bucket: row.bucket, value: JSON.parse(row.value) }))
  }

  /* ---------------------------- objects ---------------------------- */

  putObject(record) {
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
    )
  }

  getObject(bucket, key, versionId = null) {
    const row = versionId
      ? this.statements.getVersion.get(bucket, toKeyBuffer(key), versionId)
      : this.statements.getLatest.get(bucket, toKeyBuffer(key))
    return decodeRow(row)
  }

  allVersionsOfKey(bucket, key) {
    return this.statements.allVersionsOfKey.all(bucket, toKeyBuffer(key)).map(decodeRow)
  }

  clearLatest(bucket, key) {
    this.statements.clearLatest.run(bucket, toKeyBuffer(key))
  }

  /** After removing the current version, the next newest takes its place. */
  promoteLatest(bucket, key) {
    const keyBuffer = toKeyBuffer(key)
    this.statements.promoteLatest.run(bucket, keyBuffer, bucket, keyBuffer)
  }

  deleteVersion(bucket, key, versionId) {
    return this.statements.deleteVersion.run(bucket, toKeyBuffer(key), versionId).changes > 0
  }

  setTags(bucket, key, versionId, tags) {
    this.statements.updateTags.run(
      tags && Object.keys(tags).length ? JSON.stringify(tags) : null,
      bucket, toKeyBuffer(key), versionId,
    )
  }

  /** Every blob referenced by the bucket, for garbage collection on drop. */
  blobsInBucket(bucket) {
    const ids = []
    for (const row of this.statements.allObjects.all(bucket)) {
      if (row.blob_id) ids.push(row.blob_id)
      if (row.parts) for (const part of JSON.parse(row.parts)) ids.push(part.blobId)
    }
    return ids
  }

  objectsModifiedBefore(bucket, cutoff) {
    return this.statements.expiredObjects.all(bucket, cutoff).map(decodeRow)
  }

  _scan(bucket, cursor, upperBound, limit) {
    return upperBound
      ? this.statements.scanLatestRange.all(bucket, cursor, upperBound, limit)
      : this.statements.scanLatest.all(bucket, cursor, limit)
  }

  /**
   * Ordered prefix scan with delimiter roll-up. When a key falls inside a
   * common prefix the cursor jumps past the whole group rather than walking
   * every key in it.
   */
  listObjects(bucket, {
    prefix = '', delimiter = '', maxKeys = 1000, startAfter = '', cursor: resumeCursor = null,
  } = {}) {
    const prefixBuf = toKeyBuffer(prefix)
    const delimiterBuf = delimiter ? toKeyBuffer(delimiter) : null
    const upperBound = prefixUpperBound(prefixBuf)

    let cursor = prefixBuf
    // A resume cursor is an inclusive lower bound; startAfter is exclusive.
    if (resumeCursor && Buffer.compare(resumeCursor, cursor) > 0) cursor = resumeCursor
    if (startAfter) {
      const startAfterBuf = keySuccessor(startAfter)
      if (Buffer.compare(startAfterBuf, cursor) > 0) cursor = startAfterBuf
    }

    const contents = []
    const commonPrefixes = []
    const seenPrefixes = new Set()
    let truncated = false
    let nextCursor = null

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
            if (!bound) { cursor = null; break outer }
            cursor = bound
            continue outer
          }
        }

        if (contents.length + commonPrefixes.length >= maxKeys) {
          truncated = true
          nextCursor = cursor
          break outer
        }
        contents.push(decodeRow(row))
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

  /**
   * ListObjectVersions: every version and delete marker, ordered by key then
   * newest-first, paged on the (key-marker, version-id-marker) pair S3 uses.
   */
  listVersions(bucket, {
    prefix = '', delimiter = '', maxKeys = 1000, keyMarker = '', versionIdMarker = '',
  } = {}) {
    const prefixBuf = toKeyBuffer(prefix)
    const delimiterBuf = delimiter ? toKeyBuffer(delimiter) : null
    const upperBound = prefixUpperBound(prefixBuf)

    let cursorKey = prefixBuf
    let cursorSequence = Number.MAX_SAFE_INTEGER
    if (keyMarker) {
      const markerKey = toKeyBuffer(keyMarker)
      if (Buffer.compare(markerKey, cursorKey) >= 0) {
        cursorKey = markerKey
        // Without a version marker the whole key has been consumed already.
        cursorSequence = Number.MIN_SAFE_INTEGER
        if (versionIdMarker) {
          const row = this.statements.getVersion.get(bucket, markerKey, versionIdMarker)
          if (row) cursorSequence = row.sequence
        }
      }
    }

    const scan = (limit) => (upperBound
      ? this.statements.scanVersionsRange.all(bucket, cursorKey, cursorKey, cursorSequence, upperBound, limit)
      : this.statements.scanVersions.all(bucket, cursorKey, cursorKey, cursorSequence, limit))

    const versions = []
    const commonPrefixes = []
    const seenPrefixes = new Set()
    let truncated = false
    let nextKeyMarker = null
    let nextVersionIdMarker = null

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
        versions.push(record)
        cursorKey = key
        cursorSequence = row.sequence
        nextKeyMarker = key.toString('utf8')
        nextVersionIdMarker = record.versionId
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

  /* -------------------------- multipart ---------------------------- */

  createUpload({ uploadId, bucket, key, contentType, metadata, tags, encryption }) {
    this.statements.createUpload.run(
      uploadId, bucket, toKeyBuffer(key), Date.now(),
      contentType ?? null,
      metadata && Object.keys(metadata).length ? JSON.stringify(metadata) : null,
      tags && Object.keys(tags).length ? JSON.stringify(tags) : null,
      encryption ? JSON.stringify(encryption) : null,
    )
  }

  _decodeUpload(row) {
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

  getUpload(uploadId) {
    return this._decodeUpload(this.statements.getUpload.get(uploadId))
  }

  listUploads(bucket, maxUploads = 1000) {
    return this.statements.listUploads.all(bucket, maxUploads).map((row) => this._decodeUpload(row))
  }

  uploadsStartedBefore(bucket, cutoff) {
    return this.statements.staleUploads.all(bucket, cutoff).map((row) => this._decodeUpload(row))
  }

  putPart({ uploadId, partNumber, size, etag, blobId }) {
    this.statements.putPart.run(uploadId, partNumber, size, etag, blobId, Date.now())
  }

  getPart(uploadId, partNumber) {
    const row = this.statements.getPart.get(uploadId, partNumber)
    return row
      ? { partNumber: row.part_number, size: row.size, etag: row.etag, blobId: row.blob_id, uploadedAt: new Date(row.uploaded_at) }
      : null
  }

  listParts(uploadId, { partNumberMarker = 0, maxParts = 1000 } = {}) {
    return this.statements.listParts.all(uploadId, partNumberMarker, maxParts).map((row) => ({
      partNumber: row.part_number,
      size: row.size,
      etag: row.etag,
      blobId: row.blob_id,
      uploadedAt: new Date(row.uploaded_at),
    }))
  }

  allParts(uploadId) {
    return this.statements.allParts.all(uploadId).map((row) => ({
      partNumber: row.part_number,
      size: row.size,
      etag: row.etag,
      blobId: row.blob_id,
    }))
  }

  deleteUpload(uploadId) {
    this.statements.deleteParts.run(uploadId)
    this.statements.deleteUpload.run(uploadId)
  }
}
