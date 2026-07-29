/**
 * Interoperability check against the real AWS SDK for JavaScript v3.
 *
 * This is the objective compatibility signal: the SDK builds the requests, so
 * nothing here can accidentally agree with a bug in our own signing code. It
 * exercises the two shapes that break most S3-compatible servers — `aws-chunked`
 * bodies and the CRC32 trailer the SDK has enabled by default since v3.729.0
 * (docs/plan.md sections 3 and 4).
 *
 * Not part of `npm test`: it needs the SDK installed.
 *
 *   npm install
 *   npm run test:interop
 */
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  S3Client, CreateBucketCommand, DeleteBucketCommand, ListBucketsCommand,
  PutObjectCommand, GetObjectCommand, HeadObjectCommand,
  DeleteObjectsCommand, ListObjectsV2Command, ListObjectsCommand, CopyObjectCommand,
  HeadBucketCommand, CreateMultipartUploadCommand, UploadPartCopyCommand,
  CompleteMultipartUploadCommand, PutBucketVersioningCommand,
  PutObjectLockConfigurationCommand, GetObjectLockConfigurationCommand,
  PutObjectRetentionCommand, GetObjectRetentionCommand,
  PutObjectLegalHoldCommand, GetObjectLegalHoldCommand, DeleteObjectCommand,
} from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { createServer } from '../../dist/src/index.js'

const CREDENTIALS = { accessKeyId: 'AKIDINTEROP', secretAccessKey: 'interop-secret-key-value' }
const BUCKET = 'interop-bucket'

const dataRoot = await mkdtemp(join(tmpdir(), 's3node-interop-'))
const server = await createServer({ dataDir: join(dataRoot, 'data'), credentials: [CREDENTIALS] })

const s3 = new S3Client({
  endpoint: server.endpoint,
  region: 'us-east-1',
  forcePathStyle: true,
  credentials: CREDENTIALS,
})

let passed = 0
let failed = 0

async function check(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  PASS  ${name}`)
  } catch (err) {
    failed++
    console.log(`  FAIL  ${name}`)
    console.log(`        ${err.name}: ${err.message}`)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const collect = async (stream) => {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return Buffer.concat(chunks)
}

console.log(`\naws-sdk-js v3 interop against ${server.endpoint}\n`)

await check('CreateBucket', async () => {
  await s3.send(new CreateBucketCommand({ Bucket: BUCKET }))
})

await check('HeadBucket', async () => {
  await s3.send(new HeadBucketCommand({ Bucket: BUCKET }))
})

await check('ListBuckets', async () => {
  const result = await s3.send(new ListBucketsCommand({}))
  assert(result.Buckets.some((b) => b.Name === BUCKET), 'bucket missing from listing')
})

// The SDK wraps the body in aws-chunked framing and appends an
// x-amz-checksum-crc32 trailer by default. A server that stores the request
// body verbatim corrupts this object without reporting any error.
const payload = randomBytes(12_345)
await check('PutObject (aws-chunked body + default CRC32 trailer)', async () => {
  const result = await s3.send(new PutObjectCommand({
    Bucket: BUCKET, Key: 'docs/report.txt', Body: payload,
    ContentType: 'text/plain', Metadata: { author: 'ada' },
  }))
  assert(result.ETag === `"${createHash('md5').update(payload).digest('hex')}"`,
    `unexpected ETag ${result.ETag}`)
})

await check('GetObject returns the exact bytes, with no framing stored', async () => {
  const result = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'docs/report.txt' }))
  const body = await collect(result.Body)
  assert(body.equals(payload), `body mismatch: got ${body.length} of ${payload.length} bytes`)
  assert(!body.includes(Buffer.from('chunk-signature')), 'aws-chunked framing leaked into the object')
})

await check('HeadObject reports metadata', async () => {
  const result = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: 'docs/report.txt' }))
  assert(result.ContentLength === payload.length, 'wrong ContentLength')
  assert(result.ContentType === 'text/plain', `wrong ContentType ${result.ContentType}`)
  assert(result.Metadata?.author === 'ada', 'user metadata lost')
})

// The SDK validates any checksum header it receives against the bytes it read,
// so a whole-object checksum on a 206 response is a hard failure.
await check('GetObject with a Range', async () => {
  const result = await s3.send(new GetObjectCommand({
    Bucket: BUCKET, Key: 'docs/report.txt', Range: 'bytes=100-199',
  }))
  const body = await collect(result.Body)
  assert(body.equals(payload.subarray(100, 200)), 'range mismatch')
  assert(result.ContentRange === `bytes 100-199/${payload.length}`,
    `wrong ContentRange ${result.ContentRange}`)
})

await check('PutObject with an explicit CRC32 checksum', async () => {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET, Key: 'checksummed.bin', Body: Buffer.from('123456789'),
    ChecksumAlgorithm: 'CRC32',
  }))
})

await check('PutObject with a SHA256 checksum', async () => {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET, Key: 'sha.bin', Body: Buffer.from('hello'), ChecksumAlgorithm: 'SHA256',
  }))
})

await check('Keys with spaces, accents and emoji survive a round trip', async () => {
  for (const key of ['pasta com espaço/relatório.txt', 'emoji/\u{1F600}.txt', "quote'and(paren)"]) {
    await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: key }))
    const result = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }))
    assert((await collect(result.Body)).toString() === key, `round trip failed for ${key}`)
  }
})

await check('ListObjectsV2 with a delimiter', async () => {
  const result = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Delimiter: '/' }))
  const prefixes = (result.CommonPrefixes ?? []).map((p) => p.Prefix)
  assert(prefixes.includes('docs/'), `expected docs/ in common prefixes, got ${prefixes}`)
  assert(result.Contents.some((o) => o.Key === 'checksummed.bin'), 'top-level key missing')
})

await check('ListObjectsV2 paginates with a continuation token', async () => {
  const seen = []
  let token
  do {
    const page = await s3.send(new ListObjectsV2Command({
      Bucket: BUCKET, MaxKeys: 2, ContinuationToken: token,
    }))
    seen.push(...(page.Contents ?? []).map((o) => o.Key))
    token = page.IsTruncated ? page.NextContinuationToken : undefined
  } while (token)
  assert(new Set(seen).size === seen.length, 'pagination repeated a key')
  assert(seen.includes('docs/report.txt'), 'pagination dropped a key')
})

await check('ListObjects (V1) still works', async () => {
  const result = await s3.send(new ListObjectsCommand({ Bucket: BUCKET, MaxKeys: 2 }))
  assert(result.Contents.length === 2, 'wrong page size')
  assert(result.IsTruncated === true, 'expected a truncated V1 page')
})

await check('CopyObject', async () => {
  await s3.send(new CopyObjectCommand({
    Bucket: BUCKET, Key: 'docs/copy.txt', CopySource: `/${BUCKET}/docs/report.txt`,
  }))
  const result = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'docs/copy.txt' }))
  assert((await collect(result.Body)).equals(payload), 'copy content mismatch')
})

const large = randomBytes(12 * 1024 * 1024)
await check('Multipart upload via lib-storage (12 MiB in 5 MiB parts)', async () => {
  const upload = new Upload({
    client: s3,
    params: { Bucket: BUCKET, Key: 'large.bin', Body: large },
    partSize: 5 * 1024 * 1024,
    queueSize: 3,
  })
  const result = await upload.done()
  assert(/-3"?$/.test(result.ETag), `expected a 3-part ETag, got ${result.ETag}`)
})

await check('Multipart object reads back byte-identical', async () => {
  const result = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'large.bin' }))
  const body = await collect(result.Body)
  assert(body.length === large.length, `size ${body.length} != ${large.length}`)
  assert(body.equals(large), 'multipart content mismatch')
})

await check('Range read straddling a multipart part boundary', async () => {
  const start = 5 * 1024 * 1024 - 10
  const end = 5 * 1024 * 1024 + 9
  const result = await s3.send(new GetObjectCommand({
    Bucket: BUCKET, Key: 'large.bin', Range: `bytes=${start}-${end}`,
  }))
  assert((await collect(result.Body)).equals(large.subarray(start, end + 1)), 'cross-part range mismatch')
})

await check('Presigned GET URL', async () => {
  const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: 'docs/report.txt' }),
    { expiresIn: 300 })
  const response = await fetch(url)
  assert(response.ok, `presigned GET returned ${response.status}`)
  assert(Buffer.from(await response.arrayBuffer()).equals(payload), 'presigned body mismatch')
})

await check('Presigned PUT URL', async () => {
  const url = await getSignedUrl(s3, new PutObjectCommand({ Bucket: BUCKET, Key: 'presigned.txt' }),
    { expiresIn: 300 })
  const response = await fetch(url, { method: 'PUT', body: 'uploaded via presigned url' })
  assert(response.ok, `presigned PUT returned ${response.status}`)
  const stored = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'presigned.txt' }))
  assert((await collect(stored.Body)).toString() === 'uploaded via presigned url',
    'presigned PUT content wrong')
})

await check('NoSuchKey is surfaced as a typed SDK error', async () => {
  try {
    await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'does-not-exist' }))
    throw new Error('expected a failure')
  } catch (err) {
    assert(err.name === 'NoSuchKey', `expected NoSuchKey, got ${err.name}`)
  }
})

await check('NoSuchBucket is surfaced as a typed SDK error', async () => {
  try {
    await s3.send(new ListObjectsV2Command({ Bucket: 'absent-bucket-xyz' }))
    throw new Error('expected a failure')
  } catch (err) {
    assert(err.name === 'NoSuchBucket', `expected NoSuchBucket, got ${err.name}`)
  }
})

await check('UploadPartCopy assembles an object from ranges of another', async () => {
  const source = randomBytes(12 * 1024 * 1024)
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'copy-source.bin', Body: source }))

  const created = await s3.send(new CreateMultipartUploadCommand({ Bucket: BUCKET, Key: 'copy-target.bin' }))
  const ranges = [[0, 6 * 1024 * 1024 - 1], [6 * 1024 * 1024, source.length - 1]]
  const parts = []
  for (const [index, [first, last]] of ranges.entries()) {
    const copied = await s3.send(new UploadPartCopyCommand({
      Bucket: BUCKET, Key: 'copy-target.bin',
      UploadId: created.UploadId, PartNumber: index + 1,
      CopySource: `${BUCKET}/copy-source.bin`,
      CopySourceRange: `bytes=${first}-${last}`,
    }))
    parts.push({ PartNumber: index + 1, ETag: copied.CopyPartResult.ETag })
  }
  await s3.send(new CompleteMultipartUploadCommand({
    Bucket: BUCKET, Key: 'copy-target.bin',
    UploadId: created.UploadId, MultipartUpload: { Parts: parts },
  }))

  const got = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'copy-target.bin' }))
  const bytes = Buffer.from(await got.Body.transformToByteArray())
  assert(bytes.equals(source), 'copied object differs from its source')
})

await check('Object Lock retention and legal hold', async () => {
  const locked = 'interop-locked-bucket'
  await s3.send(new CreateBucketCommand({ Bucket: locked }))
  await s3.send(new PutBucketVersioningCommand({
    Bucket: locked, VersioningConfiguration: { Status: 'Enabled' },
  }))
  await s3.send(new PutObjectLockConfigurationCommand({
    Bucket: locked, ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled' },
  }))
  const config = await s3.send(new GetObjectLockConfigurationCommand({ Bucket: locked }))
  assert(config.ObjectLockConfiguration.ObjectLockEnabled === 'Enabled', 'lock not reported as enabled')

  const stored = await s3.send(new PutObjectCommand({ Bucket: locked, Key: 'wormed.txt', Body: 'immutable' }))
  const retainUntil = new Date(Date.now() + 86400_000)
  await s3.send(new PutObjectRetentionCommand({
    Bucket: locked, Key: 'wormed.txt', VersionId: stored.VersionId,
    Retention: { Mode: 'GOVERNANCE', RetainUntilDate: retainUntil },
  }))
  const retention = await s3.send(new GetObjectRetentionCommand({
    Bucket: locked, Key: 'wormed.txt', VersionId: stored.VersionId,
  }))
  assert(retention.Retention.Mode === 'GOVERNANCE', `expected GOVERNANCE, got ${retention.Retention.Mode}`)

  try {
    await s3.send(new DeleteObjectCommand({ Bucket: locked, Key: 'wormed.txt', VersionId: stored.VersionId }))
    throw new Error('expected the retained version to be undeletable')
  } catch (err) {
    assert(err.name === 'AccessDenied' || err.$metadata?.httpStatusCode === 403,
      `expected AccessDenied, got ${err.name}`)
  }

  await s3.send(new PutObjectLegalHoldCommand({
    Bucket: locked, Key: 'wormed.txt', VersionId: stored.VersionId, LegalHold: { Status: 'ON' },
  }))
  const hold = await s3.send(new GetObjectLegalHoldCommand({
    Bucket: locked, Key: 'wormed.txt', VersionId: stored.VersionId,
  }))
  assert(hold.LegalHold.Status === 'ON', `expected legal hold ON, got ${hold.LegalHold.Status}`)

  await s3.send(new DeleteObjectCommand({
    Bucket: locked, Key: 'wormed.txt', VersionId: stored.VersionId,
    BypassGovernanceRetention: true,
  })).then(
    () => { throw new Error('legal hold must outrank the governance bypass') },
    (err) => assert(err.name === 'AccessDenied' || err.$metadata?.httpStatusCode === 403,
      `expected AccessDenied, got ${err.name}`),
  )
})

await check('DeleteObjects in bulk', async () => {
  const listed = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET }))
  const result = await s3.send(new DeleteObjectsCommand({
    Bucket: BUCKET, Delete: { Objects: listed.Contents.map((o) => ({ Key: o.Key })) },
  }))
  assert((result.Errors ?? []).length === 0, `bulk delete reported errors: ${JSON.stringify(result.Errors)}`)
  const after = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET }))
  assert(!after.Contents, `bucket still holds ${after.Contents?.length} objects`)
})

await check('DeleteBucket', async () => {
  await s3.send(new DeleteBucketCommand({ Bucket: BUCKET }))
})

await server.close()
await rm(dataRoot, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
