# Programmatic Usage

Embed s3node directly in your Node.js application or test suite with `createServer()`.

## Basic server

```js
import { createServer } from '@felipedsvit/s3node'

const server = await createServer({
  dataDir: './s3node-data',
  credentials: [
    { accessKeyId: 'AKIDTEST', secretAccessKey: 'test-secret' },
  ],
})

console.log(`Listening on ${server.endpoint}`)
// http://127.0.0.1:49302

// Later:
await server.close()
```

## Programmatic options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `dataDir` | `string` | *(required)* | Path to data directory |
| `credentials` | `Credential[]` | `[]` | `{ accessKeyId, secretAccessKey }` entries |
| `port` | `number` | `0` (auto) | Listen port; `0` picks a free port |
| `host` | `string` | `'127.0.0.1'` | Bind address |
| `region` | `string` | `'us-east-1'` | Region reported to clients |
| `virtualHostDomain` | `string \| null` | `null` | Base domain for `bucket.domain` addressing |
| `minPartSize` | `number` | `5 * 1024 * 1024` | Minimum non-final multipart part size |
| `maxObjectSize` | `number` | `5 * 1024 * 1024 * 1024 * 1024` | Max object size (5 TiB) |
| `maxConcurrentUploads` | `number` | `1000` | In-flight multipart uploads limit |
| `maxConcurrentWrites` | `number` | `0` (unlimited) | Concurrent blob write limit |
| `encryptionMasterKey` | `string \| Buffer \| null` | `null` | SSE-S3 master key |
| `lifecycleIntervalMs` | `number` | `0` (off) | Lifecycle sweep interval |
| `notificationIntervalMs` | `number` | `2000` | Notification queue poll interval (ms) |
| `rateLimitPerSecond` | `number` | unset | Sustained request rate limit (per caller) |
| `rateLimitBurst` | `number` | same as `rateLimitPerSecond` | Burst capacity |
| `logger` | `{ error: (entry) => void } \| null` | `null` | Error logger |
| `reusePort` | `boolean` | `false` | `SO_REUSEPORT` support |

## Use in a test suite

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

// Use the client like any S3 client
await client.send(new PutObjectCommand({ Bucket: 'b', Key: 'k', Body: 'hello' }))

await s3node.close()
```

## Vitest / Jest global setup

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

## Lifecycle sweeps

Lifecycle expiration does not run automatically. You must set `lifecycleIntervalMs` or call `runLifecycle()` yourself:

```js
// Automatic sweep every hour
const server = await createServer({
  dataDir: './data',
  lifecycleIntervalMs: 3600_000,
})

// Or manual trigger
const summary = await server.runLifecycle()
console.log(summary)
// { expiredObjects: 5, expiredVersions: 2, abortedUploads: 1 }
```

## Garbage Collection

```js
import { createServer, GarbageCollector } from '@felipedsvit/s3node'

const server = await createServer({ dataDir: './data' })
const gc = new GarbageCollector(server.store)

// Scan only (read-only)
const report = await gc.scan()
console.log(report)
// { scanned: 100, referenced: 95, orphaned: 5 }

// Collect orphans
const result = await gc.collect()
console.log(result)
// { scanned: 100, referenced: 95, orphaned: 5, removed: 3, cleanedDirs: 2 }
```

## Multipart cleanup

```js
import { createServer, MultipartCleanup } from '@felipedsvit/s3node'

const server = await createServer({ dataDir: './data' })
const cleanup = new MultipartCleanup(server.store)
const aborted = await cleanup.cleanup(24) // abort uploads older than 24h
console.log(`Aborted ${aborted} stale uploads`)
```