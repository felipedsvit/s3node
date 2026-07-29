# Architecture

## Three key design decisions

### 1. aws-chunked decoding

The AWS CLI does not send object bytes raw — it frames them with per-chunk signatures (`aws-chunked` content encoding). A server that writes the request body straight to disk stores the framing too, corrupting every CLI upload without raising an error.

s3node's `ChunkedDecoder` (in `src/auth/chunked.ts`) strips the framing and verifies the per-chunk signature chain before the body reaches the storage layer.

### 2. Blob names are decoupled from object keys

Object keys may contain `../` — they never become filesystem paths. This removes path traversal by construction, along with the case-folding and name-length problems of key-as-path layouts.

Each object gets a random UUID-based blob ID stored in a 2-level hex fanout directory structure.

### 3. Metadata in SQLite, not the filesystem

`ListObjectsV2` with a prefix is an ordered range scan. The primary key index gives O(log n + k). A `readdir` over the bucket is O(n) and unordered.

Keys are stored as `BLOB` so SQLite orders them by UTF-8 bytes. JavaScript string comparison uses UTF-16 code units and disagrees on surrogate pairs.

## Source organization

```
src/
  auth/          SigV4, credentials, chunked encoding
  console/       Admin web UI and JSON API
  features/      Lifecycle, notifications, CORS, policies, Object Lock, encryption, tagging, POST
  handlers/      HTTP request handlers (bucket, object, multipart, config, POST)
  storage/       ObjectStore, SQLite metadata, blob storage, garbage collector
  util/          Rate limiter, semaphore, hashing, CRC, buffer pool
  server.ts      Core server class
  http.ts        Request parsing, range headers, preconditions
  router.ts      Route resolution
  errors.ts      S3 error codes
  metrics.ts     Prometheus metrics
  cluster.ts     Multi-worker supervision
```

## Request lifecycle

1. HTTP request arrives at the server
2. Router matches method + URL to a handler and resolves the action ARN
3. If auth is present, SigV4 is verified (or treated as anonymous)
4. CORS headers are evaluated for cross-origin requests
5. Rate limiter checks the caller's token bucket
6. Handler processes the request (may read/write to ObjectStore)
7. Notifications are enqueued for matching events
8. Metrics are recorded
9. XML or binary response is sent

## Write durability

The write path is ordered so a crash can only leave an orphan blob, never metadata pointing at missing data:

1. Stream to `tmp/` temp file
2. `fsync` temp file
3. `rename` to final `data/<xx>/<yy>/<blobId>`
4. `fsync` parent directory
5. Commit metadata row to SQLite

## Why Node.js?

s3node exists because no Go or Rust S3 server can run inside your Node.js process. This makes it uniquely suited for:
- Test suites that need a real S3 endpoint without Docker
- Embedded storage in Electron apps
- Development environments where spinning up containers is overhead
