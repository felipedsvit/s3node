import type { DatabaseSync } from 'node:sqlite'
import { keySuccessor, prefixUpperBound, toKeyBuffer } from '../../util/bytes.js'
import { NULL_VERSION } from './schema.js'
import {
  decodeRow,
  type ListObjectsResult,
  type ListVersionsResult,
  type MaxSeqRow,
  type ObjectInput,
  type ObjectRecord,
  type RawRow,
} from './types.js'

const LIST_BATCH = 512

interface ObjectStatements {
  putObject: ReturnType<DatabaseSync['prepare']>
  updateLock: ReturnType<DatabaseSync['prepare']>
  getVersion: ReturnType<DatabaseSync['prepare']>
  getLatest: ReturnType<DatabaseSync['prepare']>
  allVersionsOfKey: ReturnType<DatabaseSync['prepare']>
  clearLatest: ReturnType<DatabaseSync['prepare']>
  promoteLatest: ReturnType<DatabaseSync['prepare']>
  deleteVersion: ReturnType<DatabaseSync['prepare']>
  updateTags: ReturnType<DatabaseSync['prepare']>
  maxSequence: ReturnType<DatabaseSync['prepare']>
  scanLatest: ReturnType<DatabaseSync['prepare']>
  scanLatestRange: ReturnType<DatabaseSync['prepare']>
  scanVersions: ReturnType<DatabaseSync['prepare']>
  scanVersionsRange: ReturnType<DatabaseSync['prepare']>
  allObjects: ReturnType<DatabaseSync['prepare']>
  allBlobIds: ReturnType<DatabaseSync['prepare']>
  allPartsBlobIds: ReturnType<DatabaseSync['prepare']>
  deleteAllObjects: ReturnType<DatabaseSync['prepare']>
  expiredObjects: ReturnType<DatabaseSync['prepare']>
}

/** Object CRUD, versioning, and the key-listing engine (`listObjects`/`listVersions`). */
export class ObjectMetadata {
  private statements: ObjectStatements
  private _sequence: number

  constructor(db: DatabaseSync) {
    this.statements = {
      putObject: db.prepare(`
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
      updateLock: db.prepare(
        'UPDATE objects SET retention_mode = ?, retain_until = ?, legal_hold = ? ' +
        ' WHERE bucket = ? AND key = ? AND version_id = ?'),
      getVersion: db.prepare('SELECT * FROM objects WHERE bucket = ? AND key = ? AND version_id = ?'),
      getLatest: db.prepare(
        'SELECT * FROM objects WHERE bucket = ? AND key = ? AND is_latest = 1'),
      allVersionsOfKey: db.prepare(
        'SELECT * FROM objects WHERE bucket = ? AND key = ? ORDER BY sequence DESC'),
      clearLatest: db.prepare(
        'UPDATE objects SET is_latest = 0 WHERE bucket = ? AND key = ? AND is_latest = 1'),
      promoteLatest: db.prepare(`
        UPDATE objects SET is_latest = 1
         WHERE bucket = ? AND key = ? AND version_id = (
           SELECT version_id FROM objects WHERE bucket = ? AND key = ?
            ORDER BY sequence DESC LIMIT 1)`),
      deleteVersion: db.prepare(
        'DELETE FROM objects WHERE bucket = ? AND key = ? AND version_id = ?'),
      updateTags: db.prepare(
        'UPDATE objects SET tags = ? WHERE bucket = ? AND key = ? AND version_id = ?'),
      maxSequence: db.prepare('SELECT IFNULL(MAX(sequence), 0) AS value FROM objects'),

      scanLatest: db.prepare(`
        SELECT * FROM objects
         WHERE bucket = ? AND key >= ? AND is_latest = 1 AND is_delete_marker = 0
         ORDER BY key ASC LIMIT ?`),
      scanLatestRange: db.prepare(`
        SELECT * FROM objects
         WHERE bucket = ? AND key >= ? AND key < ? AND is_latest = 1 AND is_delete_marker = 0
         ORDER BY key ASC LIMIT ?`),
      scanVersions: db.prepare(`
        SELECT * FROM objects
         WHERE bucket = ? AND (key > ? OR (key = ? AND sequence < ?))
         ORDER BY key ASC, sequence DESC LIMIT ?`),
      scanVersionsRange: db.prepare(`
        SELECT * FROM objects
         WHERE bucket = ? AND (key > ? OR (key = ? AND sequence < ?)) AND key < ?
         ORDER BY key ASC, sequence DESC LIMIT ?`),
      allObjects: db.prepare('SELECT blob_id, parts FROM objects WHERE bucket = ?'),
      allBlobIds: db.prepare('SELECT blob_id FROM objects WHERE blob_id IS NOT NULL'),
      allPartsBlobIds: db.prepare('SELECT parts FROM objects WHERE parts IS NOT NULL'),
      deleteAllObjects: db.prepare('DELETE FROM objects WHERE bucket = ?'),
      expiredObjects: db.prepare(`
        SELECT * FROM objects WHERE bucket = ? AND last_modified < ? ORDER BY key ASC`),
    }

    this._sequence = (this.statements.maxSequence.get() as unknown as MaxSeqRow).value
  }

  nextSequence(): number {
    this._sequence = Math.max(this._sequence + 1, Date.now())
    return this._sequence
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

  /** Every blobId referenced from `objects.blob_id`/`objects.parts`, for the garbage collector. */
  allBlobIds(): string[] {
    const ids: string[] = []
    for (const row of this.statements.allBlobIds.all() as { blob_id: string }[]) {
      ids.push(row.blob_id)
    }
    for (const row of this.statements.allPartsBlobIds.all() as { parts: string }[]) {
      try {
        for (const part of JSON.parse(row.parts) as { blobId: string }[]) {
          if (part.blobId) ids.push(part.blobId)
        }
      } catch { /* skip malformed parts JSON */ }
    }
    return ids
  }

  /** Deletes every object row for a bucket; called when the bucket itself is deleted. */
  deleteAllInBucket(bucket: string): void {
    this.statements.deleteAllObjects.run(bucket)
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
}
