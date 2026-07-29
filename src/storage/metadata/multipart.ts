import type { DatabaseSync } from 'node:sqlite'
import type { EncryptionContext } from '../../features/encryption.js'
import { toKeyBuffer } from '../../util/bytes.js'
import type { CountRow, PartRecord, PartRow, UploadRecord, UploadRow } from './types.js'

interface MultipartStatements {
  createUpload: ReturnType<DatabaseSync['prepare']>
  getUpload: ReturnType<DatabaseSync['prepare']>
  deleteUpload: ReturnType<DatabaseSync['prepare']>
  listUploads: ReturnType<DatabaseSync['prepare']>
  countUploads: ReturnType<DatabaseSync['prepare']>
  staleUploads: ReturnType<DatabaseSync['prepare']>
  staleUploadsGlobal: ReturnType<DatabaseSync['prepare']>
  putPart: ReturnType<DatabaseSync['prepare']>
  getPart: ReturnType<DatabaseSync['prepare']>
  listParts: ReturnType<DatabaseSync['prepare']>
  allParts: ReturnType<DatabaseSync['prepare']>
  deleteParts: ReturnType<DatabaseSync['prepare']>
  allUploadPartBlobIds: ReturnType<DatabaseSync['prepare']>
}

/** Multipart upload tracking: in-progress uploads and their uploaded parts. */
export class MultipartMetadata {
  private statements: MultipartStatements

  constructor(db: DatabaseSync) {
    this.statements = {
      createUpload: db.prepare(
        'INSERT INTO uploads (upload_id, bucket, key, initiated_at, content_type, metadata, tags, encryption) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
      getUpload: db.prepare('SELECT * FROM uploads WHERE upload_id = ?'),
      deleteUpload: db.prepare('DELETE FROM uploads WHERE upload_id = ?'),
      listUploads: db.prepare(
        'SELECT * FROM uploads WHERE bucket = ? ORDER BY key ASC, upload_id ASC LIMIT ?'),
      countUploads: db.prepare('SELECT count(*) AS total FROM uploads WHERE bucket = ?'),
      staleUploads: db.prepare('SELECT * FROM uploads WHERE bucket = ? AND initiated_at < ?'),
      staleUploadsGlobal: db.prepare('SELECT * FROM uploads WHERE initiated_at < ?'),

      putPart: db.prepare(`
        INSERT INTO upload_parts (upload_id, part_number, size, etag, blob_id, uploaded_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (upload_id, part_number) DO UPDATE SET
          size = excluded.size, etag = excluded.etag,
          blob_id = excluded.blob_id, uploaded_at = excluded.uploaded_at`),
      getPart: db.prepare('SELECT * FROM upload_parts WHERE upload_id = ? AND part_number = ?'),
      listParts: db.prepare(
        'SELECT * FROM upload_parts WHERE upload_id = ? AND part_number > ? ORDER BY part_number ASC LIMIT ?'),
      allParts: db.prepare('SELECT * FROM upload_parts WHERE upload_id = ? ORDER BY part_number ASC'),
      deleteParts: db.prepare('DELETE FROM upload_parts WHERE upload_id = ?'),
      allUploadPartBlobIds: db.prepare('SELECT blob_id FROM upload_parts'),
    }
  }

  createUpload({ uploadId, bucket, key, contentType, metadata, tags, encryption }: {
    uploadId: string
    bucket: string
    key: string
    contentType?: string | undefined
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

  /** Every blobId referenced from `upload_parts.blob_id`, for the garbage collector. */
  allUploadPartBlobIds(): string[] {
    return (this.statements.allUploadPartBlobIds.all() as { blob_id: string }[]).map((row) => row.blob_id)
  }
}
