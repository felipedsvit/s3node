# s3node

An embeddable, S3-compatible object storage server for Node.js. Zero runtime
dependencies — metadata lives in the built-in `node:sqlite`, hashing in
`node:crypto`, HTTP in `node:http`.

The design rationale, the compatibility traps, and the honest limits are in
[`docs/plan.md`](docs/plan.md).

> "S3-compatible". Amazon S3 is a trademark of Amazon Web Services.

## Install

Requires Node.js 22.5 or newer (for `node:sqlite`).

```sh
npm install s3node
```

## Run as a server

```sh
npx s3node --data-dir ./data --port 9000
```

A credential is generated and printed on first run; pass `--access-key` /
`--secret-key` (or `S3NODE_ACCESS_KEY_ID` / `S3NODE_SECRET_ACCESS_KEY`) to keep
it stable. `s3node --help` lists every option.

```sh
aws --endpoint-url http://127.0.0.1:9000 s3 ls
aws --endpoint-url http://127.0.0.1:9000 s3 cp ./file.bin s3://my-bucket/
```

## Run in-process

This is the part no Go or Rust server can do: a real S3 endpoint inside your
test process, no container, no binary to download.

```js
import { createServer } from 's3node'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'

const credentials = { accessKeyId: 'AKIDTEST', secretAccessKey: 'test-secret' }
const s3node = await createServer({ dataDir: './tmp-data', credentials: [credentials] })

const client = new S3Client({
  endpoint: s3node.endpoint,   // http://127.0.0.1:<random port>
  region: 'us-east-1',
  forcePathStyle: true,
  credentials,
})

await client.send(new PutObjectCommand({ Bucket: 'b', Key: 'k', Body: 'hello' }))
await s3node.close()
```

### Options

| Option | Default | Meaning |
|---|---|---|
| `dataDir` | *(required)* | Directory holding blobs and `metadata.sqlite` |
| `credentials` | `[]` | `{ accessKeyId, secretAccessKey }` entries |
| `port` / `host` | `0` / `127.0.0.1` | `0` picks a free port |
| `region` | `us-east-1` | Region reported to clients |
| `virtualHostDomain` | `null` | Base domain to enable `bucket.domain` addressing |
| `minPartSize` | `5 MiB` | Minimum size of a non-final multipart part |
| `logger` | `null` | `{ error(entry) }`; logs include the canonical request on signature failures |

## Supported API

**Service** — ListBuckets.

**Bucket** — CreateBucket, DeleteBucket, HeadBucket, GetBucketLocation,
GetBucketVersioning, ListObjectsV2, ListObjects (V1), DeleteObjects.

**Object** — PutObject, GetObject, HeadObject, DeleteObject, CopyObject, with
`Range`, conditional headers (`If-Match`, `If-None-Match`, `If-Modified-Since`,
`If-Unmodified-Since`), `x-amz-meta-*`, and response header overrides.

**Multipart** — CreateMultipartUpload, UploadPart, CompleteMultipartUpload,
AbortMultipartUpload, ListParts, ListMultipartUploads.

**Auth** — SigV4 in the `Authorization` header and in presigned URLs, across all
four payload modes: literal SHA-256, `UNSIGNED-PAYLOAD`,
`STREAMING-AWS4-HMAC-SHA256-PAYLOAD`, and `STREAMING-UNSIGNED-PAYLOAD-TRAILER` —
including per-chunk signature verification and `x-amz-checksum-*` trailers.

**Not implemented** — versioning, bucket policy/ACL, CORS, lifecycle, tagging,
server-side encryption, event notifications, POST form uploads. These return
`NotImplemented` rather than silently succeeding.

## Design notes

Three decisions do most of the work; each is argued in `docs/plan.md`.

**`aws-chunked` decoding.** The aws-cli does not send object bytes raw — it
frames them with per-chunk signatures. A server that writes the request body
straight to disk stores the framing too, corrupting every CLI upload without
raising an error. `src/auth/chunked.js` strips the framing and verifies the
signature chain.

**Blob names are decoupled from object keys.** A key may contain `../`; it never
becomes a filesystem path. That removes path traversal by construction, along
with the case-folding and name-length problems of key-as-path layouts.

**Metadata in SQLite, not the filesystem.** `ListObjectsV2` with a prefix is an
ordered range scan. The primary key index makes it `O(log n + k)`; a `readdir`
over the bucket is `O(n)` and unordered. Keys are stored as `BLOB` so SQLite
orders them by UTF-8 bytes — JavaScript string comparison uses UTF-16 code units
and disagrees on surrogate pairs.

The write path is ordered so that a crash can only ever leave an orphan blob,
never metadata pointing at missing data: stream to a temp file, `fsync`,
`rename`, `fsync` the parent directory, and only then commit the metadata row.

## Tests

```sh
npm test               # 153 unit and HTTP-level tests, no network needed
npm run test:interop   # drives the real @aws-sdk/client-s3 against an in-process server
```

The interop suite is the meaningful compatibility signal: the AWS SDK builds the
requests, so it cannot accidentally agree with a bug in our own signing code. It
covers the two shapes that break most S3-compatible servers — `aws-chunked`
bodies and the CRC32 trailer the SDK has sent by default since v3.729.0.

SigV4 is additionally pinned to the known-answer vectors published in the AWS
documentation, in `test/sigv4.test.js`.

## Limits

Single node. Durability is delegated to the filesystem underneath (RAID/ZFS) —
there is no erasure coding and no multi-node replication, and that is a
deliberate scope decision rather than a gap: it is where Node loses to Go and
Rust. Node also has no `sendfile` binding, so every read pays extra copies. See
`docs/plan.md` sections 6 and 10 for the numbers to measure and the criteria for
abandoning the approach.

## License

ISC.
