export { S3NodeServer, supportsReusePort } from './server.js'
export type { ServerOptions, CreateOptions } from './server.js'
export { CredentialStore, generateCredential } from './auth/credentials.js'
export type { Credential } from './auth/credentials.js'
export { ObjectStore } from './storage/store.js'
export type {
  PutObjectInput, PutObjectResult, DeleteObjectResult,
  CopyObjectInput, CopyObjectResult, UploadPartInput, UploadPartResult,
  CreateMultipartResult, CompleteMultipartInput, AbortMultipartInput,
} from './storage/store.js'
export { BlobStore } from './storage/blobs.js'
export type { WriteResult, BlobPart } from './storage/blobs.js'
export { MetadataStore, NULL_VERSION, SCHEMA_VERSION } from './storage/metadata.js'
export type { ObjectRecord, BucketRecord, UploadRecord, PartRecord, ObjectInput } from './storage/metadata.js'
export { S3Error, ERROR_CODES } from './errors.js'
export type { S3ErrorDetail } from './errors.js'
export { ChunkedDecoder, encodeChunked } from './auth/chunked.js'
export { EncryptionManager } from './features/encryption.js'
export type { SseRequest, EncryptionContext, CreatedEncryption } from './features/encryption.js'
export { evaluatePolicy, parsePolicy } from './features/policy.js'
export { runLifecycle } from './features/lifecycle.js'
export { GarbageCollector } from './storage/gc.js'
export type { GCStats } from './storage/gc.js'
export { MultipartCleanup } from './storage/multipartCleanup.js'
export type { CleanupStats } from './storage/multipartCleanup.js'
export { NotificationDispatcher, buildEvent } from './features/notifications.js'
export type { NotificationConfig } from './features/notifications.js'
export { ConsoleServer } from './console/server.js'
export type { ConsoleOptions } from './console/server.js'
export { runCluster, clusterSupported, defaultWorkerCount } from './cluster.js'
export type { ClusterOptions } from './cluster.js'
export * as sigv4 from './auth/sigv4.js'

import { S3NodeServer } from './server.js'
import type { CreateOptions } from './server.js'

export async function createServer(options: CreateOptions & { reusePort?: boolean } = {} as CreateOptions): Promise<S3NodeServer> {
  const server = await S3NodeServer.create(options)
  const address = await server.listen(options.port ?? 0, options.host ?? '127.0.0.1',
    { reusePort: options.reusePort ?? false })
  server.endpoint = address!.endpoint
  return server
}
