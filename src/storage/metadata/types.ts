import type { EncryptionContext } from '../../features/encryption.js'
import type { BlobPart } from '../blobs.js'

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

export interface ObjectInput {
  bucket: string
  key: string
  versionId?: string
  sequence?: number
  isLatest?: boolean
  isDeleteMarker?: boolean
  size: number
  etag: string
  contentType?: string | undefined
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

export interface RawRow {
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

export function decodeRow(row: RawRow | undefined): ObjectRecord | null {
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

export interface ConfigRow {
  value: string
}

export interface BucketRow {
  name: string
  created_at: number
  region: string
}

export interface CountRow {
  total: number
}

export interface UsageRow {
  objects: number
  bytes: number
}

export interface NotificationQueueRow {
  id: number
  bucket: string
  target_id: string
  endpoint: string
  payload: string
  attempts: number
}

export interface MaxSeqRow {
  value: number
}

export interface PartRow {
  part_number: number
  size: number
  etag: string
  blob_id: string
  uploaded_at: number
}

export interface UploadRow {
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
