<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/felipedsvit/s3node/main/assets/logo-cube-dark.svg">
  <img src="https://raw.githubusercontent.com/felipedsvit/s3node/main/assets/favicon.svg" alt="s3node" width="96">
</picture>

# s3node

**An S3-compatible object storage server that runs inside your Node.js process.**
No container, no binary to download, no runtime dependencies — metadata lives in the
built-in `node:sqlite`, hashing in `node:crypto`, HTTP in `node:http`.

[![npm](https://img.shields.io/npm/v/%40felipedsvit%2Fs3node)](https://www.npmjs.com/package/@felipedsvit/s3node)
[![node](https://img.shields.io/node/v/%40felipedsvit%2Fs3node)](https://nodejs.org)
[![dependencies](https://img.shields.io/badge/runtime%20deps-0-brightgreen)](package.json)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

```sh
npx @felipedsvit/s3node --data-dir ./data --port 9000
```

That's a working S3 endpoint on `http://127.0.0.1:9000`. Point the AWS CLI, the AWS
SDK, or rclone at it.

> "S3-compatible". Amazon S3 is a trademark of Amazon Web Services.

## Why s3node?

- **It runs in-process.** `await createServer()` gives your test suite a real S3
  endpoint in the same process — no Docker daemon, no port juggling, no fixture
  container to wait on. This is the part no Go or Rust server can do.
- **Zero runtime dependencies.** One `npm install`, nothing transitive, nothing to
  audit. It only needs Node 22.5+.
- **It says no out loud.** Unsupported settings return `NotImplemented` instead of
  succeeding silently, so you never ship believing an ACL or a replication rule was
  applied.

|                              | s3node                | MinIO                  | LocalStack            |
| ---------------------------- | --------------------- | ---------------------- | --------------------- |
| Runs inside your Node process | yes                   | no                     | no                    |
| Install                      | npm package, 0 deps   | Go binary / container  | Docker + Python       |
| Startup                      | milliseconds          | ~a second + image pull | seconds               |
| Scope                        | the S3 API            | S3 + erasure coding    | most of AWS           |
| Multi-node replication       | no                    | yes                    | no                    |

**Use something else if** you need multi-node replication, erasure coding, or AWS
services beyond S3. s3node is a single node that delegates durability to the
filesystem underneath it — see [Limits](#limits).

## Install

Requires **Node.js 22.5 or newer** (for `node:sqlite`). Cluster mode needs 22.12.

```sh
npm install @felipedsvit/s3node
```

## Quickstart

```sh
npx @felipedsvit/s3node --data-dir ./data --port 9000
```

```
s3node listening on http://127.0.0.1:9000
  data dir     /home/you/project/data
  region       us-east-1
  access key   493C07B6058B1FD72FEC
  secret key   rn_vaYnwVLH-x1GmOw7exX_FnR1ha885XSxQxdWl

This credential was generated for this run. Pass --access-key/--secret-key
(or S3NODE_ACCESS_KEY_ID / S3NODE_SECRET_ACCESS_KEY) to keep it stable.
```

The credential is regenerated on every start unless you pin it. Copy the two lines
the banner prints and use them:

```sh
export AWS_ACCESS_KEY_ID=493C07B6058B1FD72FEC
export AWS_SECRET_ACCESS_KEY=rn_vaYnwVLH-x1GmOw7exX_FnR1ha885XSxQxdWl

aws --endpoint-url http://127.0.0.1:9000 s3 mb s3://my-bucket
aws --endpoint-url http://127.0.0.1:9000 s3 cp ./file.bin s3://my-bucket/
aws --endpoint-url http://127.0.0.1:9000 s3 ls s3://my-bucket
```

## Use it in your tests

```js
import { createServer } from '@felipedsvit/s3node'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'

const credentials = { accessKeyId: 'AKIDTEST', secretAccessKey: 'test-secret' }
const s3node = await createServer({ dataDir: './tmp-data', credentials: [credentials] })

const client = new S3Client({
  endpoint: s3node.endpoint,   // http://127.0.0.1:<random port>
  region: 'us-east-1',
  forcePathStyle: true,        // required: path-style unless virtualHostDomain is set
  credentials,
})

await client.send(new PutObjectCommand({ Bucket: 'b', Key: 'k', Body: 'hello' }))
await s3node.close()
```

`port` defaults to `0`, so every server grabs a free port and parallel test files never
collide.

## Recipes

### Vitest / Jest global setup

Give the whole suite one server on a throwaway directory.

```js
// test/setup.js
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from '@felipedsvit/s3node'

let server, dataDir

export async function setup() {
  dataDir = await mkdtemp(join(tmpdir(), 's3node-'))
  server = await createServer({
    dataDir,
    credentials: [{ accessKeyId: 'AKIDTEST', secretAccessKey: 'test-secret' }],
  })
  process.env.S3_ENDPOINT = server.endpoint
}

export async function teardown() {
  await server.close()
  await rm(dataDir, { recursive: true, force: true })
}
```

```js
// vitest.config.js
export default { test: { globalSetup: './test/setup.js' } }
```

### Presigned URLs

```js
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'

const putUrl = await getSignedUrl(client, new PutObjectCommand({ Bucket: 'uploads', Key: 'report.pdf' }), { expiresIn: 900 })
await fetch(putUrl, { method: 'PUT', body: bytes })

const getUrl = await getSignedUrl(client, new GetObjectCommand({ Bucket: 'uploads', Key: 'report.pdf' }), { expiresIn: 900 })
```

Response header overrides (`response-content-type`, `response-content-disposition`, …)
work on presigned GETs.

### rclone

```sh
rclone config create s3node s3 \
  provider=Other \
  endpoint=http://127.0.0.1:9000 \
  access_key_id=$AWS_ACCESS_KEY_ID \
  secret_access_key=$AWS_SECRET_ACCESS_KEY \
  region=us-east-1

rclone sync ./photos s3node:my-bucket/photos
```

### Admin console

```sh
npx @felipedsvit/s3node --data-dir ./data --port 9000 --console-port 9001
```

A dependency-free web UI on `http://127.0.0.1:9001` for browsing buckets and objects,
uploading, downloading and deleting. It gets its own port rather than a path on the S3
endpoint because every path there is already a bucket name — `/console` would shadow a
bucket called `console`.

It authenticates with an s3node credential over HTTP Basic and speaks plain HTTP, so it
binds `--host` (loopback by default). **Put it behind TLS before letting it off the
machine.**

There is a small JSON API behind the same auth:

```sh
curl -u $AWS_ACCESS_KEY_ID:$AWS_SECRET_ACCESS_KEY http://127.0.0.1:9001/api/info
# {"region":"us-east-1","version":"0.1.6","buckets":0,"objects":0,"bytes":0}
```

### Cluster mode

```sh
npx @felipedsvit/s3node --data-dir ./data --port 9000 --cluster     # one worker per core
npx @felipedsvit/s3node --data-dir ./data --port 9000 --cluster 4   # four workers
```

Each worker binds the same port with `SO_REUSEPORT` and the kernel spreads connections.
Metadata stays consistent through SQLite's WAL, which lets readers run while one writer
commits — so **workers scale request handling, not the metadata write rate.** Needs Node
22.12+. The console and the lifecycle sweep run on worker 1 only.

## CLI reference

| Flag | Default | Meaning |
| --- | --- | --- |
| `--data-dir <path>` | `./s3node-data` | Where blobs and `metadata.sqlite` live |
| `--port <number>` | `9000` | Port to listen on |
| `--host <address>` | `127.0.0.1` | Address to bind |
| `--region <name>` | `us-east-1` | Region reported to clients |
| `--access-key <id>` | generated | Also `S3NODE_ACCESS_KEY_ID` |
| `--secret-key <secret>` | generated | Also `S3NODE_SECRET_ACCESS_KEY` |
| `--virtual-host <domain>` | off | Base domain for `bucket.domain` addressing |
| `--cluster [count]` | off | One worker per core, or the given count |
| `--console-port <port>` | off | Serve the admin console on this port |
| `--quiet` | off | Do not print request errors |
| `--help` | | Show usage |

`--access-key` and `--secret-key` must be given together.

## Programmatic options

`createServer(options)` — everything but `dataDir` is optional.

| Option | Default | Meaning |
| --- | --- | --- |
| `dataDir` | *(required)* | Directory holding blobs and `metadata.sqlite` |
| `credentials` | `[]` | `{ accessKeyId, secretAccessKey }` entries |
| `port` / `host` | `0` / `127.0.0.1` | `0` picks a free port |
| `region` | `us-east-1` | Region reported to clients |
| `virtualHostDomain` | `null` | Base domain to enable `bucket.domain` addressing |
| `minPartSize` | `5 MiB` | Minimum size of a non-final multipart part |
| `maxObjectSize` | `5 TiB` | Rejected above this |
| `maxConcurrentUploads` | `1000` | Multipart uploads in flight |
| `encryptionMasterKey` | `null` | SSE-S3 master key; otherwise read from `dataDir/master.key` |
| `lifecycleIntervalMs` | `0` | **Lifecycle sweeps are off unless this is > 0** |
| `reusePort` | `false` | `SO_REUSEPORT`, for running several servers on one port |
| `logger` | `null` | `{ error(entry) }`; logs include the canonical request on signature failures |

Lifecycle expiration has no CLI flag — it only runs when you pass `lifecycleIntervalMs`,
or when you call `server.runLifecycle()` yourself.

## Supported API

**Service** — ListBuckets.

**Bucket** — CreateBucket, DeleteBucket, HeadBucket, GetBucketLocation, ListObjectsV2,
ListObjects (V1), ListObjectVersions, DeleteObjects, ListMultipartUploads, and
Get/Put/Delete for BucketVersioning, BucketPolicy, BucketCORS,
LifecycleConfiguration, BucketTagging and BucketNotification. Get/Put
ObjectLockConfiguration.

**Object** — PutObject, GetObject, HeadObject, DeleteObject, CopyObject, with `Range`,
conditional headers (`If-Match`, `If-None-Match`, `If-Modified-Since`,
`If-Unmodified-Since`), `x-amz-meta-*`, object tagging, SSE-C and SSE-S3 server-side
encryption, `x-amz-checksum-*` headers and trailers (CRC32, CRC32C, SHA1, SHA256), and
response header overrides for presigned URLs.

**Multipart** — CreateMultipartUpload, UploadPart, UploadPartCopy (with
`x-amz-copy-source-range`), CompleteMultipartUpload, AbortMultipartUpload, ListParts,
ListMultipartUploads.

**Auth** — SigV4 in the `Authorization` header and in presigned URLs (query-string
authentication), across all four payload modes: literal SHA-256, `UNSIGNED-PAYLOAD`,
`STREAMING-AWS4-HMAC-SHA256-PAYLOAD`, and `STREAMING-UNSIGNED-PAYLOAD-TRAILER` —
including per-chunk signature verification and `x-amz-checksum-*` trailers. Anonymous
requests are allowed through and then judged by bucket policy.

**POST** — Browser form uploads (`POST /{bucket}`) with signed policy documents,
including `${filename}` key substitution, `content-length-range` validation, and
`success_action_redirect` / `success_action_status`.

**Notifications** — Event notifications via webhook, fired on object creation (Put,
Post, Copy, CompleteMultipartUpload) and removal (Delete, DeleteMarkerCreated).
Fire-and-forget with a 5s timeout.

**Lifecycle** — Age-based and date-based expiration rules, including non-current version
expiration and incomplete multipart upload abortion.

**Object Lock** — WORM retention in GOVERNANCE and COMPLIANCE modes plus legal holds,
per object version. Requires a versioned bucket. GOVERNANCE yields to
`x-amz-bypass-governance-retention`; COMPLIANCE yields to nobody, and a legal hold
outranks both. Locks apply to destroying a version — writing a delete marker over a
locked object is still allowed, since that hides the data without losing it.

### Not implemented

These return `NotImplemented` rather than silently succeeding, so the client gets an
explicit error instead of believing a setting was applied:

`acl`, `website`, `replication`, `encryption` (bucket-level default; SSE-C and SSE-S3 on
objects do work), `accelerate`, `logging`, `requestPayment`, `analytics`, `inventory`,
`metrics`, `publicAccessBlock`, `intelligent-tiering`, `ownershipControls`, `restore`,
`select`.

## How it works

Three decisions do most of the work; each is argued in [`docs/plan.md`](docs/plan.md)
(written in Portuguese).

**`aws-chunked` decoding.** The aws-cli does not send object bytes raw — it frames them
with per-chunk signatures. A server that writes the request body straight to disk stores
the framing too, corrupting every CLI upload without raising an error.
`src/auth/chunked.ts` strips the framing and verifies the signature chain.

**Blob names are decoupled from object keys.** A key may contain `../`; it never becomes
a filesystem path. That removes path traversal by construction, along with the
case-folding and name-length problems of key-as-path layouts.

**Metadata in SQLite, not the filesystem.** `ListObjectsV2` with a prefix is an ordered
range scan. The primary key index makes it `O(log n + k)`; a `readdir` over the bucket
is `O(n)` and unordered. Keys are stored as `BLOB` so SQLite orders them by UTF-8 bytes
— JavaScript string comparison uses UTF-16 code units and disagrees on surrogate pairs.

The write path is ordered so that a crash can only ever leave an orphan blob, never
metadata pointing at missing data: stream to a temp file, `fsync`, `rename`, `fsync` the
parent directory, and only then commit the metadata row.

### What lands on disk

```
<data-dir>/
  data/            object blobs, two-level hex fanout
  tmp/             staging for the durable write path
  metadata.sqlite  buckets, objects, uploads (WAL mode)
  master.key       SSE-S3 master key
```

## Tests

```sh
npm test               # 301 unit and HTTP-level tests, no network needed
npm run test:interop   # drives the real @aws-sdk/client-s3 against an in-process server
```

The interop suite is the meaningful compatibility signal: the AWS SDK builds the
requests, so it cannot accidentally agree with a bug in our own signing code. It covers
the two shapes that break most S3-compatible servers — `aws-chunked` bodies and the
CRC32 trailer the SDK has sent by default since v3.729.0.

SigV4 is additionally pinned to the known-answer vectors published in the AWS
documentation, in `test/sigv4.test.js`.

## Limits

Single node. Durability is delegated to the filesystem underneath (RAID/ZFS) — there is
no erasure coding and no multi-node replication, and that is a deliberate scope decision
rather than a gap: it is where Node loses to Go and Rust. Node also has no `sendfile`
binding, so every read pays extra copies. See `docs/plan.md` sections 6 and 10 for the
numbers to measure and the criteria for abandoning the approach.

## License

MIT. See [LICENSE](LICENSE).
