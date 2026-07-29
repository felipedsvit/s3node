/** Input and result shapes exchanged across the storage service boundary. */

import type { EncryptionContext, SseRequest } from '../features/encryption.js'
import type { LockState } from '../features/objectlock.js'

export interface PutObjectInput {
  bucket: string
  key: string
  body: NodeJS.ReadableStream | NodeJS.ReadableStream[]
  contentType?: string
  metadata?: Record<string, string>
  tags?: Record<string, string>
  contentMd5?: string | null
  expectedSha256?: string | null
  checksumAlgorithm?: string | null
  expectedChecksum?: string | null
  trailerProvider?: ((name: string) => string | null) | null
  encryptionRequest?: SseRequest | null
  /** Object Lock state requested via headers; merged over the bucket default. */
  lock?: Partial<LockState> | null
}

export interface PutObjectResult {
  etag: string
  size: number
  lastModified: Date
  checksums: Record<string, string>
  versionId: string
  versioned: boolean
  encryption: EncryptionContext | null
}

export interface DeleteObjectResult {
  deleted: boolean
  versionId?: string
  deleteMarker?: boolean
}

export interface CopyObjectInput {
  sourceBucket: string
  sourceKey: string
  sourceVersionId?: string | null
  bucket: string
  key: string
  metadata?: Record<string, string>
  contentType?: string
  replaceMetadata: boolean
  tags?: Record<string, string>
  replaceTags: boolean
  sourceEncryptionRequest?: SseRequest | null
  encryptionRequest?: SseRequest | null
}

export interface CopyObjectResult {
  etag: string
  lastModified: Date
  size: number
  versionId: string
  versioned: boolean
  encryption: EncryptionContext | null
}

export interface CreateMultipartInput {
  bucket: string
  key: string
  contentType?: string
  metadata?: Record<string, string>
  tags?: Record<string, string>
  encryptionRequest?: SseRequest | null
}

export interface CreateMultipartResult {
  uploadId: string
  encryption: EncryptionContext | null
}

export interface UploadPartInput {
  bucket: string
  key: string
  uploadId: string
  partNumber: number
  body: NodeJS.ReadableStream | NodeJS.ReadableStream[]
  contentMd5?: string | null
  expectedSha256?: string | null
  checksumAlgorithm?: string | null
  expectedChecksum?: string | null
  trailerProvider?: ((name: string) => string | null) | null
  encryptionRequest?: SseRequest | null
}

export interface UploadPartResult {
  etag: string
  size: number
  encryption: EncryptionContext | null
}

export interface UploadPartCopyInput {
  bucket: string
  key: string
  uploadId: string
  partNumber: number
  sourceBucket: string
  sourceKey: string
  sourceVersionId?: string | null
  /** Byte range of the source object to copy; the whole object when absent. */
  sourceRange?: { start: number; end: number } | null
  sourceEncryptionRequest?: SseRequest | null
  encryptionRequest?: SseRequest | null
}

export interface UploadPartCopyResult {
  etag: string
  size: number
  lastModified: Date
  encryption: EncryptionContext | null
  sourceVersionId: string | null
}

export interface CompleteMultipartInput {
  bucket: string
  key: string
  uploadId: string
  requestedParts: { partNumber: number; etag: string }[]
}

export interface AbortMultipartInput {
  bucket: string
  key: string
  uploadId: string
}

export interface ListObjectsOptions {
  prefix?: string
  delimiter?: string
  maxKeys?: number
  startAfter?: string
  cursor?: Buffer | null
}

export interface ListVersionsOptions {
  prefix?: string
  delimiter?: string
  maxKeys?: number
  keyMarker?: string
  versionIdMarker?: string
}

export interface ListPartsOptions {
  partNumberMarker?: number
  maxParts?: number
}
