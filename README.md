# [s3node](https://github.com/felipedsvit/s3node) &middot; [![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![npm version](https://img.shields.io/npm/v/@felipedsvit/s3node.svg?style=flat)](https://www.npmjs.com/package/@felipedsvit/s3node) [![Node.js](https://img.shields.io/badge/node-%3E%3D22.5.0-brightgreen)](https://nodejs.org) [![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/felipedsvit/s3node/pulls)

**s3node** is an embeddable, S3-compatible object storage server that runs inside your Node.js process. No containers, no binaries, no runtime dependencies.

- **Zero-infrastructure testing:** Spin up a real S3 endpoint in your test suite without Docker or external services.
- **Embeddable by design:** Import `createServer()` and get a full S3 API — no subprocess, no HTTP orchestration.
- **API-compatible:** Implements the S3 REST API — SigV4, presigned URLs, multipart uploads, lifecycle, notifications, Object Lock, CORS, bucket policies, and more.
- **Node.js native:** Built on `node:http`, `node:sqlite`, and `node:crypto` — zero npm runtime dependencies.

[Getting started](docs/getting-started.md) &middot; [Installation](docs/installation.md) &middot; [S3 API Reference](docs/s3-api.md) &middot; [Programmatic usage](docs/programmatic.md) &middot; [Architecture](docs/architecture.md) &middot; [Contributing](https://github.com/felipedsvit/s3node/pulls)

## Installation

s3node requires **Node.js >= 22.5.0** (>= 22.12.0 for cluster mode) and has **zero runtime dependencies**.

```sh
npm install @felipedsvit/s3node
```

Or run directly with npx — no install required:

```sh
npx @felipedsvit/s3node --data-dir ./data --port 9000
```

## Quick start

### CLI

```sh
npx @felipedsvit/s3node --data-dir ./data --port 9000
```

```sh
# Use with the AWS CLI
export AWS_ACCESS_KEY_ID=<printed-by-banner>
export AWS_SECRET_ACCESS_KEY=<printed-by-banner>

aws --endpoint-url http://127.0.0.1:9000 s3 mb s3://my-bucket
aws --endpoint-url http://127.0.0.1:9000 s3 cp ./file.bin s3://my-bucket/
```

### Programmatic

```js
import { createServer } from '@felipedsvit/s3node'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'

const credentials = { accessKeyId: 'AKIDTEST', secretAccessKey: 'test-secret' }
const s3node = await createServer({ dataDir: './tmp-data', credentials: [credentials] })

const client = new S3Client({
  endpoint: s3node.endpoint,
  region: 'us-east-1',
  forcePathStyle: true,
  credentials,
})

await client.send(new PutObjectCommand({ Bucket: 'b', Key: 'k', Body: 'hello' }))
await s3node.close()
```
## CLI Reference

| Flag | Env var | Default | Description |
|------|---------|---------|-------------|
| `--data-dir <path>` | --- | `./s3node-data` | Directory for blobs + `metadata.sqlite` |
| `--port <number>` | --- | `9000` | S3 API listening port |
| `--host <address>` | --- | `127.0.0.1` | Bind address |
| `--region <name>` | --- | `us-east-1` | Region reported to clients |
| `--access-key <id>` | `S3NODE_ACCESS_KEY_ID` | auto-generated | Access key for SigV4 |
| `--secret-key <secret>` | `S3NODE_SECRET_ACCESS_KEY` | auto-generated | Secret key for SigV4 |
| `--virtual-host <domain>` | --- | off | Enable `bucket.domain` addressing |
| `--cluster [count]` | --- | off | Workers: one per core or explicit count |
| `--console-port <port>` | --- | off | Admin console HTTP port |
| `--quiet` | --- | false | Suppress request error logging |
| `--help` | --- | --- | Show usage |

`--access-key` and `--secret-key` must be given together.

## Examples

```sh
# Basic server
s3node --data-dir ./data --port 9000

# With stable credentials
s3node --data-dir ./data --access-key AKIDTEST --secret-key test-secret

## Documentation

| Document | Description |
|----------|-------------|
| [Getting Started](docs/getting-started.md) | Run the server, create a bucket, upload and download |
| [CLI Reference](docs/cli.md) | All command-line flags and environment variables |
| [Programmatic Usage](docs/programmatic.md) | Embed s3node with `createServer()` |
| [Installation](docs/installation.md) | Requirements, npm install, credential auto-generation |
| [Configuration](docs/configuration.md) | Complete config map: CLI, env, programmatic |
| [Admin Console](docs/admin-console.md) | Web UI, JSON API, health and endpoints |
| [S3 API Reference](docs/s3-api.md) | All supported S3 operations + NotImplemented list |
| [Authentication](docs/authentication.md) | SigV4, presigned URLs, chunked encoding, POST policy |
| [Encryption](docs/encryption.md) | SSE-C and SSE-S3 server-side encryption |
| [Storage](docs/storage.md) | On-disk layout, atomic writes, SQLite schema, blob fanout |
| [Architecture](docs/architecture.md) | Design decisions, how it works |
| [Features](docs/features.md) | Lifecycle, notifications, Object Lock, CORS, policies, tagging |
| [Cluster Mode](docs/cluster.md) | Multi-worker with SO_REUSEPORT |
| [Testing](docs/testing.md) | Running tests, interop suite, coverage |
| [Limits](docs/limits.md) | Known limits, comparisons with MinIO and LocalStack |

## Examples

### Server-side encryption

```js
const s3node = await createServer({
  dataDir: './data',
  sseS3Key: 'a'.repeat(64), // 256-bit key for SSE-S3
  credentials: [{ accessKeyId: 'AKID', secretAccessKey: 'sk' }],
})
```

### Bucket lifecycle rules

```js
await server.runLifecycle()
// { expiredObjects: 5, expiredVersions: 2, abortedUploads: 1 }
```

### Event notifications

```js
const webhookConfig = {
  queueArn: 'arn:webhook:http://example.com/hook',
  events: ['s3:ObjectCreated:*'],
}
```

## Contributing

s3node is MIT-licensed and open to contributions. We welcome bug reports, feature requests, and pull requests.

- Read our [Security Policy](SECURITY.md) before reporting vulnerabilities.
- Check existing [issues](https://github.com/felipedsvit/s3node/issues) before opening new ones.
- Run tests locally with `npm test`.

### License

s3node is [MIT licensed](./LICENSE).
