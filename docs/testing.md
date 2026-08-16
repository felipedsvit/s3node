# Testing

s3node has 418 unit and HTTP-level integration tests, plus interoperability suites that drive real S3 clients against the server.

## Running tests

```sh
# Build and run all tests
npm test

# Watch mode
npm run test:watch

# Interop suite (drives real @aws-sdk/client-s3 against in-process server)
npm run test:interop
npm run test:interop:matrix
npm run test:soak:smoke
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
| `crash-recovery.test.js` | SIGKILL fault injection across blob, WAL/metadata, migration, multipart, and GC stages |
| `backup.test.js` | Manifest-verified online backup and restore drill |
| `cache.test.js` | LRUCache: eviction, TTL, promotion |

Long-running load and the AWS CLI/boto3/rclone matrix are documented in
[Production operations](https://github.com/felipedsvit/s3node/wiki/Production-Operations).

`.github/workflows/ci.yml` runs the full suite (including SIGKILL recovery and
backup drills) on Node 22.13 and Node 24. A separate operational job installs all
three external clients and runs the ten-second soak smoke, so missing clients are
failures in CI rather than skips.

## Interop suite

The interop test (`test/interop/aws-sdk.mjs`) drives the real `@aws-sdk/client-s3` against an in-process server. This is the most meaningful compatibility signal because the SDK builds the requests — it cannot accidentally agree with a bug in s3node's own signing code.

Covers: CreateBucket, HeadBucket, ListBuckets, PutObject (with default CRC32 trailer), GetObject, CopyObject, DeleteObjects, ListObjectsV2, tagging, versioning, Object Lock, multipart via `@aws-sdk/lib-storage`, presigned URLs.

## SigV4 known-answer tests

The SigV4 implementation is pinned to the known-answer vectors published in the AWS documentation (`test/sigv4.test.js`). This validates URI encoding, canonical query strings, canonical requests, string-to-sign derivation, and final signature bytes.
