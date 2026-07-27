import { DatabaseSync } from 'node:sqlite'
import { keySuccessor, prefixUpperBound, toKeyBuffer } from '../util/bytes.js'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS buckets (
  name          TEXT PRIMARY KEY,
  created_at    INTEGER NOT NULL,
  region        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS objects (
  bucket        TEXT NOT NULL,
  key           BLOB NOT NULL,
  size          INTEGER NOT NULL,
  etag          TEXT NOT NULL,
  content_type  TEXT,
  last_modified INTEGER NOT NULL,
  blob_id       TEXT,
  parts         TEXT,
  metadata      TEXT,
  checksums     TEXT,
  PRIMARY KEY (bucket, key)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS uploads (
  upload_id     TEXT PRIMARY KEY,
  bucket        TEXT NOT NULL,
  key           BLOB NOT NULL,
  initiated_at  INTEGER NOT NULL,
  content_type  TEXT,
  metadata      TEXT
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
    size: row.size,
    etag: row.etag,
    contentType: row.content_type ?? undefined,
    lastModified: new Date(row.last_modified),
    blobId: row.blob_id ?? null,
    parts: row.parts ? JSON.parse(row.parts) : null,
    metadata: row.metadata ? JSON.parse(row.metadata) : {},
    checksums: row.checksums ? JSON.parse(row.checksums) : {},
  }
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
    this.db.exec(SCHEMA)
    this.statements = {
      createBucket: this.db.prepare('INSERT INTO buckets (name, created_at, region) VALUES (?, ?, ?)'),
      getBucket: this.db.prepare('SELECT name, created_at, region FROM buckets WHERE name = ?'),
      listBuckets: this.db.prepare('SELECT name, created_at, region FROM buckets ORDER BY name ASC'),
      deleteBucket: this.db.prepare('DELETE FROM buckets WHERE name = ?'),
      countObjects: this.db.prepare('SELECT count(*) AS total FROM objects WHERE bucket = ?'),

      putObject: this.db.prepare(`
        INSERT INTO objects (bucket, key, size, etag, content_type, last_modified, blob_id, parts, metadata, checksums)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (bucket, key) DO UPDATE SET
          size = excluded.size, etag = excluded.etag, content_type = excluded.content_type,
          last_modified = excluded.last_modified, blob_id = excluded.blob_id,
          parts = excluded.parts, metadata = excluded.metadata, checksums = excluded.checksums`),
      getObject: this.db.prepare('SELECT * FROM objects WHERE bucket = ? AND key = ?'),
      deleteObject: this.db.prepare('DELETE FROM objects WHERE bucket = ? AND key = ?'),
      scanFrom: this.db.prepare(
        'SELECT * FROM objects WHERE bucket = ? AND key >= ? ORDER BY key ASC LIMIT ?'),
      scanRange: this.db.prepare(
        'SELECT * FROM objects WHERE bucket = ? AND key >= ? AND key < ? ORDER BY key ASC LIMIT ?'),
      allObjects: this.db.prepare('SELECT blob_id, parts FROM objects WHERE bucket = ?'),

      createUpload: this.db.prepare(
        'INSERT INTO uploads (upload_id, bucket, key, initiated_at, content_type, metadata) VALUES (?, ?, ?, ?, ?, ?)'),
      getUpload: this.db.prepare('SELECT * FROM uploads WHERE upload_id = ?'),
      deleteUpload: this.db.prepare('DELETE FROM uploads WHERE upload_id = ?'),
      listUploads: this.db.prepare(
        'SELECT * FROM uploads WHERE bucket = ? ORDER BY key ASC, upload_id ASC LIMIT ?'),

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
    this.statements.deleteBucket.run(name)
  }

  isBucketEmpty(name) {
    return this.statements.countObjects.get(name).total === 0
  }

  /* ---------------------------- objects ---------------------------- */

  putObject(record) {
    this.statements.putObject.run(
      record.bucket,
      toKeyBuffer(record.key),
      record.size,
      record.etag,
      record.contentType ?? null,
      record.lastModified instanceof Date ? record.lastModified.getTime() : record.lastModified,
      record.blobId ?? null,
      record.parts ? JSON.stringify(record.parts) : null,
      record.metadata && Object.keys(record.metadata).length ? JSON.stringify(record.metadata) : null,
      record.checksums && Object.keys(record.checksums).length ? JSON.stringify(record.checksums) : null,
    )
  }

  getObject(bucket, key) {
    return decodeRow(this.statements.getObject.get(bucket, toKeyBuffer(key)))
  }

  deleteObject(bucket, key) {
    return this.statements.deleteObject.run(bucket, toKeyBuffer(key)).changes > 0
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

  _scan(bucket, cursor, upperBound, limit) {
    return upperBound
      ? this.statements.scanRange.all(bucket, cursor, upperBound, limit)
      : this.statements.scanFrom.all(bucket, cursor, limit)
  }

  /**
   * Ordered prefix scan with delimiter roll-up. When a key falls inside a
   * common prefix the cursor jumps past the whole group rather than walking
   * every key in it.
   */
  listObjects(bucket, { prefix = '', delimiter = '', maxKeys = 1000, startAfter = '', cursor: resumeCursor = null } = {}) {
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

  /* -------------------------- multipart ---------------------------- */

  createUpload({ uploadId, bucket, key, contentType, metadata }) {
    this.statements.createUpload.run(
      uploadId, bucket, toKeyBuffer(key), Date.now(),
      contentType ?? null,
      metadata && Object.keys(metadata).length ? JSON.stringify(metadata) : null,
    )
  }

  getUpload(uploadId) {
    const row = this.statements.getUpload.get(uploadId)
    if (!row) return null
    return {
      uploadId: row.upload_id,
      bucket: row.bucket,
      key: Buffer.from(row.key),
      initiatedAt: new Date(row.initiated_at),
      contentType: row.content_type ?? undefined,
      metadata: row.metadata ? JSON.parse(row.metadata) : {},
    }
  }

  listUploads(bucket, maxUploads = 1000) {
    return this.statements.listUploads.all(bucket, maxUploads).map((row) => ({
      uploadId: row.upload_id,
      bucket: row.bucket,
      key: Buffer.from(row.key),
      initiatedAt: new Date(row.initiated_at),
    }))
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
