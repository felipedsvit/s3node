# Testing

s3node has 301+ unit and HTTP-level integration tests, plus an interoperability suite that drives the real AWS SDK against the server.

## Running tests

```sh
# Build and run all tests
npm test

# Watch mode
npm run test:watch

# Interop suite (drives real @aws-sdk/client-s3 against in-process server)
npm run test:interop
```

## Test structure

| File | What it covers |
|------|----------|
| `api.test.js` | Auth, presigned URLs, chunked encoding, CORS, object CRUD, multipart, range reads, conditional headers, tagging, SSE, checksums |
| `features.test.js` | CORS config, lifecycle rules, notification dispatch |
| `storage.test.js` | ObjectStore: CRUD, versioning, multipart, encryption, blob layout |
| `sigv4.test.js` | Known-answer vectors from AWS SigV4 documentation |
| `chunked.test.js` | ChunkedDecoder: unsigned, signed, trailers, CRC32 |
| `encryption.test.js` | SSE-C and SSE-S3 round-trips, ciphertext verification |
| `policy.test.js` | Policy engine: Allow/Deny, conditions, wildcards |
| `versioning.test.js` | Versioning config, versioned CRUD, delete markers |
| `object-lock.test.js` | GOVERNANCE, COMPLIANCE, legal hold, default retention |
| `post-upload.test.js` | Form data parser, signed POST uploads |
| `upload-part-copy.test.js` | UploadPartCopy with ranges and encryption |
| `notificationQueue.test.js` | Enqueue, retry, backoff, dead-letter |
| `multipart-cleanup.test.js` | Stale upload cleanup |
| `gc.test.js` | GarbageCollector: scan, collect, orphan removal |
| `console.test.js` | Console auth, JSON API, metrics endpoint |
| `quota.test.js` | Bucket quota enforcement |
| `metrics.test.js` | MetricsRegistry rendering |
| `router.test.js` | Route resolution, ARN matching |
| `xml.test.js` | XML serialization, parsing safety |
| `cluster.test.js` | Worker count, SO_REUSEPORT, crash recovery |
| `util.test.js` | CRC, byte ordering, range parsing, semaphore, rate limiter |
| `rateLimiter.test.js` | Throttling behavior |
| `cache.test.js` | LRUCache: eviction, TTL, promotion |

## Interop suite

The interop test (`test/interop/aws-sdk.mjs`) drives the real `@aws-sdk/client-s3` against an in-process server. This is the most meaningful compatibility signal because the SDK builds the requests — it cannot accidentally agree with a bug in s3node's own signing code.

Covers: CreateBucket, HeadBucket, ListBuckets, PutObject (with default CRC32 trailer), GetObject, CopyObject, DeleteObjects, ListObjectsV2, tagging, versioning, Object Lock, multipart via `@aws-sdk/lib-storage`, presigned URLs.

## SigV4 known-answer tests

The SigV4 implementation is pinned to the known-answer vectors published in the AWS documentation (`test/sigv4.test.js`). This validates URI encoding, canonical query strings, canonical requests, string-to-sign derivation, and final signature bytes.
