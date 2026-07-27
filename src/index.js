export { S3NodeServer } from './server.js'
export { CredentialStore, generateCredential } from './auth/credentials.js'
export { ObjectStore } from './storage/store.js'
export { BlobStore } from './storage/blobs.js'
export { MetadataStore } from './storage/metadata.js'
export { S3Error, ERROR_CODES } from './errors.js'
export { ChunkedDecoder, encodeChunked } from './auth/chunked.js'
export * as sigv4 from './auth/sigv4.js'

import { S3NodeServer } from './server.js'

/**
 * Create and start a server in one call.
 *
 * Running in-process is the point of shipping this on Node: tests can boot a
 * real S3 endpoint without a container or a Go/Rust binary (docs/plan.md 5.5).
 *
 *   const s3 = await createServer({ dataDir: './data', credentials: [...] })
 *   // s3.endpoint -> http://127.0.0.1:54321
 */
export async function createServer(options = {}) {
  const server = await S3NodeServer.create(options)
  const address = await server.listen(options.port ?? 0, options.host ?? '127.0.0.1')
  server.endpoint = address.endpoint
  return server
}
