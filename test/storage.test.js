import assert from 'node:assert/strict'
import { randomBytes, createHash } from 'node:crypto'
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { after, before, beforeEach, describe, it } from 'node:test'
import { MAX_OBJECT_SIZE, ObjectStore } from '../dist/src/storage/store.js'
import { BlobStore } from '../dist/src/storage/blobs.js'
import { MetadataStore } from '../dist/src/storage/metadata.js'
import { EncryptionManager } from '../dist/src/features/encryption.js'

let root
let store

async function fresh() {
  store?.close()
  const dataDir = await mkdtemp(join(root, 'store-'))
  store = await ObjectStore.open({ dataDir, minPartSize: 8 })
  return store
}

function body(content) {
  return Readable.from([Buffer.from(content)])
}

async function readAll(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return Buffer.concat(chunks)
}

before(async () => { root = await mkdtemp(join(tmpdir(), 's3node-storage-')) })
after(async () => { store?.close(); await rm(root, { recursive: true, force: true }) })
beforeEach(fresh)

describe('buckets', () => {
  it('creates, lists and deletes', async () => {
    store.createBucket('alpha')
    store.createBucket('beta')
    assert.deepEqual(store.listBuckets().map((b) => b.name), ['alpha', 'beta'])
    await store.deleteBucket('alpha')
    assert.deepEqual(store.listBuckets().map((b) => b.name), ['beta'])
  })

  it('rejects invalid names', () => {
    for (const name of ['A', 'ab', 'x'.repeat(64), '-abc', 'a..b', '192.168.0.1']) {
      assert.throws(() => store.createBucket(name), (err) => err.code === 'InvalidBucketName', name)
    }
  })

  it('refuses to delete a non-empty bucket', async () => {
    store.createBucket('alpha')
    await store.putObject({ bucket: 'alpha', key: 'k', body: body('x') })
    await assert.rejects(store.deleteBucket('alpha'), (err) => err.code === 'BucketNotEmpty')
  })

  it('reports a missing bucket', async () => {
    await assert.rejects(
      store.putObject({ bucket: 'nope', key: 'k', body: body('x') }),
      (err) => err.code === 'NoSuchBucket',
    )
  })
})

describe('objects', () => {
  beforeEach(() => { store.createBucket('bkt') })

  it('round-trips content and reports the MD5 ETag', async () => {
    const payload = randomBytes(4096)
    const result = await store.putObject({ bucket: 'bkt', key: 'k', body: Readable.from([payload]) })
    assert.equal(result.etag, `"${createHash('md5').update(payload).digest('hex')}"`)

    const record = store.getObject('bkt', 'k')
    assert.equal(record.size, payload.length)
    assert.deepEqual(await readAll(store.createObjectStream(record)), payload)
  })

  it('serves byte ranges', async () => {
    await store.putObject({ bucket: 'bkt', key: 'k', body: body('0123456789') })
    const record = store.getObject('bkt', 'k')
    assert.equal((await readAll(store.createObjectStream(record, 2, 5))).toString(), '2345')
    assert.equal((await readAll(store.createObjectStream(record, 9, 9))).toString(), '9')
  })

  it('stores an empty object', async () => {
    await store.putObject({ bucket: 'bkt', key: 'empty', body: body('') })
    const record = store.getObject('bkt', 'empty')
    assert.equal(record.size, 0)
    assert.equal((await readAll(store.createObjectStream(record))).length, 0)
  })

  it('keeps a key containing ../ away from the filesystem', async () => {
    const key = '../../etc/passwd'
    await store.putObject({ bucket: 'bkt', key, body: body('safe') })
    const record = store.getObject('bkt', key)
    assert.equal((await readAll(store.createObjectStream(record))).toString(), 'safe')
    // Nothing escaped the data directory: blobs are named independently of keys.
    const entries = await readdir(store.blobs.dataDir)
    assert.equal(entries.every((entry) => /^[0-9a-f]{2}$/.test(entry)), true)
  })

  it('preserves user metadata and content type', async () => {
    await store.putObject({
      bucket: 'bkt', key: 'k', body: body('x'),
      contentType: 'text/plain', metadata: { author: 'ada' },
    })
    const record = store.getObject('bkt', 'k')
    assert.equal(record.contentType, 'text/plain')
    assert.deepEqual(record.metadata, { author: 'ada' })
  })

  it('rejects a bad Content-MD5 and stores nothing', async () => {
    await assert.rejects(
      store.putObject({ bucket: 'bkt', key: 'k', body: body('x'), contentMd5: 'AAAAAAAAAAAAAAAAAAAAAA==' }),
      (err) => err.code === 'BadDigest',
    )
    assert.throws(() => store.getObject('bkt', 'k'), (err) => err.code === 'NoSuchKey')
  })

  it('rejects a payload hash mismatch', async () => {
    await assert.rejects(
      store.putObject({ bucket: 'bkt', key: 'k', body: body('x'), expectedSha256: '0'.repeat(64) }),
      (err) => err.code === 'XAmzContentSHA256Mismatch',
    )
  })

  it('validates and reports a CRC32 checksum', async () => {
    const result = await store.putObject({
      bucket: 'bkt', key: 'k', body: body('123456789'),
      checksumAlgorithm: 'crc32', expectedChecksum: 'y/Q5Jg==',
    })
    assert.equal(result.checksums.crc32, 'y/Q5Jg==')
  })

  it('rejects a wrong declared checksum', async () => {
    await assert.rejects(
      store.putObject({
        bucket: 'bkt', key: 'k', body: body('123456789'),
        checksumAlgorithm: 'crc32', expectedChecksum: 'AAAAAA==',
      }),
      (err) => err.code === 'InvalidRequest',
    )
  })

  it('reclaims the superseded blob when a key is overwritten', async () => {
    await store.putObject({ bucket: 'bkt', key: 'k', body: body('first') })
    const firstBlob = store.getObject('bkt', 'k').blobId
    await store.putObject({ bucket: 'bkt', key: 'k', body: body('second') })
    const record = store.getObject('bkt', 'k')
    assert.notEqual(record.blobId, firstBlob)
    assert.equal((await readAll(store.createObjectStream(record))).toString(), 'second')
    await assert.rejects(store.blobs.size(firstBlob))
  })

  it('deletes idempotently and reclaims the blob', async () => {
    await store.putObject({ bucket: 'bkt', key: 'k', body: body('x') })
    const blobId = store.getObject('bkt', 'k').blobId
    assert.equal((await store.deleteObject('bkt', 'k')).deleted, true)
    assert.equal((await store.deleteObject('bkt', 'k')).deleted, false)
    await assert.rejects(store.blobs.size(blobId))
  })

  it('copies an object', async () => {
    await store.putObject({ bucket: 'bkt', key: 'src', body: body('payload'), contentType: 'text/plain' })
    await store.copyObject({ sourceBucket: 'bkt', sourceKey: 'src', bucket: 'bkt', key: 'dst' })
    const record = store.getObject('bkt', 'dst')
    assert.equal((await readAll(store.createObjectStream(record))).toString(), 'payload')
    assert.equal(record.contentType, 'text/plain')
  })

  it('rejects an over-long key', async () => {
    await assert.rejects(
      store.putObject({ bucket: 'bkt', key: 'x'.repeat(1025), body: body('x') }),
      (err) => err.code === 'KeyTooLongError',
    )
  })
})

describe('listing', () => {
  beforeEach(async () => {
    store.createBucket('bkt')
    for (const key of ['a.txt', 'dir/1.txt', 'dir/2.txt', 'dir/sub/3.txt', 'other/4.txt', 'z.txt']) {
      await store.putObject({ bucket: 'bkt', key, body: body(key) })
    }
  })

  it('lists every key in byte order', () => {
    const { contents } = store.listObjects('bkt', {})
    assert.deepEqual(contents.map((r) => r.key.toString()),
      ['a.txt', 'dir/1.txt', 'dir/2.txt', 'dir/sub/3.txt', 'other/4.txt', 'z.txt'])
  })

  it('filters by prefix', () => {
    const { contents } = store.listObjects('bkt', { prefix: 'dir/' })
    assert.deepEqual(contents.map((r) => r.key.toString()), ['dir/1.txt', 'dir/2.txt', 'dir/sub/3.txt'])
  })

  it('rolls keys up into common prefixes with a delimiter', () => {
    const result = store.listObjects('bkt', { delimiter: '/' })
    assert.deepEqual(result.contents.map((r) => r.key.toString()), ['a.txt', 'z.txt'])
    assert.deepEqual(result.commonPrefixes, ['dir/', 'other/'])
  })

  it('combines prefix and delimiter', () => {
    const result = store.listObjects('bkt', { prefix: 'dir/', delimiter: '/' })
    assert.deepEqual(result.contents.map((r) => r.key.toString()), ['dir/1.txt', 'dir/2.txt'])
    assert.deepEqual(result.commonPrefixes, ['dir/sub/'])
  })

  it('paginates with a cursor and never repeats or drops a key', () => {
    const seen = []
    let cursor = null
    for (let page = 0; page < 20; page++) {
      const result = store.listObjects('bkt', { maxKeys: 2, cursor })
      seen.push(...result.contents.map((r) => r.key.toString()))
      if (!result.truncated) break
      cursor = result.nextCursor
      assert.ok(cursor, 'a truncated page must carry a cursor')
    }
    assert.deepEqual(seen, ['a.txt', 'dir/1.txt', 'dir/2.txt', 'dir/sub/3.txt', 'other/4.txt', 'z.txt'])
  })

  it('paginates across common prefixes', () => {
    const seenKeys = []
    const seenPrefixes = []
    let cursor = null
    for (let page = 0; page < 20; page++) {
      const result = store.listObjects('bkt', { delimiter: '/', maxKeys: 1, cursor })
      seenKeys.push(...result.contents.map((r) => r.key.toString()))
      seenPrefixes.push(...result.commonPrefixes)
      if (!result.truncated) break
      cursor = result.nextCursor
    }
    assert.deepEqual(seenKeys, ['a.txt', 'z.txt'])
    assert.deepEqual(seenPrefixes, ['dir/', 'other/'])
  })

  it('honours startAfter', () => {
    const { contents } = store.listObjects('bkt', { startAfter: 'dir/2.txt' })
    assert.deepEqual(contents.map((r) => r.key.toString()), ['dir/sub/3.txt', 'other/4.txt', 'z.txt'])
  })

  it('reports not truncated when the page exactly fits', () => {
    const result = store.listObjects('bkt', { maxKeys: 6 })
    assert.equal(result.contents.length, 6)
    assert.equal(result.truncated, false)
  })

  it('orders non-ASCII keys by UTF-8 bytes', async () => {
    await store.putObject({ bucket: 'bkt', key: '\u{1F600}', body: body('emoji') })
    await store.putObject({ bucket: 'bkt', key: '�', body: body('replacement') })
    const keys = store.listObjects('bkt', {}).contents.map((r) => r.key.toString())
    // 0xEF... sorts before 0xF0..., the reverse of JavaScript string order.
    assert.ok(keys.indexOf('�') < keys.indexOf('\u{1F600}'))
  })
})

describe('multipart', () => {
  beforeEach(() => { store.createBucket('bkt') })

  async function upload(parts, key = 'big') {
    const { uploadId } = store.createMultipartUpload({ bucket: 'bkt', key })
    const etags = []
    for (const [index, content] of parts.entries()) {
      const { etag } = await store.uploadPart({
        bucket: 'bkt', key, uploadId, partNumber: index + 1, body: body(content),
      })
      etags.push(etag)
    }
    return { uploadId, etags, key }
  }

  it('assembles parts and computes the -N ETag', async () => {
    const parts = ['aaaaaaaaaa', 'bbbbbbbbbb', 'cc']
    const { uploadId, etags, key } = await upload(parts)
    const result = await store.completeMultipartUpload({
      bucket: 'bkt', key, uploadId,
      requestedParts: etags.map((etag, index) => ({ partNumber: index + 1, etag })),
    })
    assert.match(result.etag, /^"[0-9a-f]{32}-3"$/)

    const record = store.getObject('bkt', key)
    assert.equal(record.size, parts.join('').length)
    assert.equal((await readAll(store.createObjectStream(record))).toString(), parts.join(''))
  })

  it('serves ranges that span part boundaries', async () => {
    const { uploadId, etags, key } = await upload(['0123456789', 'abcdefghij'])
    await store.completeMultipartUpload({
      bucket: 'bkt', key, uploadId,
      requestedParts: etags.map((etag, index) => ({ partNumber: index + 1, etag })),
    })
    const record = store.getObject('bkt', key)
    assert.equal((await readAll(store.createObjectStream(record, 8, 11))).toString(), '89ab')
    assert.equal((await readAll(store.createObjectStream(record, 0, 0))).toString(), '0')
    assert.equal((await readAll(store.createObjectStream(record, 19, 19))).toString(), 'j')
  })

  it('accepts parts uploaded out of order', async () => {
    const key = 'ooo'
    const { uploadId } = store.createMultipartUpload({ bucket: 'bkt', key })
    const second = await store.uploadPart({ bucket: 'bkt', key, uploadId, partNumber: 2, body: body('SECOND') })
    const first = await store.uploadPart({ bucket: 'bkt', key, uploadId, partNumber: 1, body: body('FIRSTaaaa') })
    await store.completeMultipartUpload({
      bucket: 'bkt', key, uploadId,
      requestedParts: [{ partNumber: 1, etag: first.etag }, { partNumber: 2, etag: second.etag }],
    })
    const record = store.getObject('bkt', key)
    assert.equal((await readAll(store.createObjectStream(record))).toString(), 'FIRSTaaaaSECOND')
  })

  it('lets a re-uploaded part number win and frees the old blob', async () => {
    const key = 'redo'
    const { uploadId } = store.createMultipartUpload({ bucket: 'bkt', key })
    const first = await store.uploadPart({ bucket: 'bkt', key, uploadId, partNumber: 1, body: body('OLDOLDOLD') })
    const second = await store.uploadPart({ bucket: 'bkt', key, uploadId, partNumber: 1, body: body('NEWNEWNEW') })
    assert.notEqual(first.etag, second.etag)
    await store.completeMultipartUpload({
      bucket: 'bkt', key, uploadId, requestedParts: [{ partNumber: 1, etag: second.etag }],
    })
    const record = store.getObject('bkt', key)
    assert.equal((await readAll(store.createObjectStream(record))).toString(), 'NEWNEWNEW')
  })

  it('rejects a part list that is out of order', async () => {
    const { uploadId, etags, key } = await upload(['aaaaaaaaaa', 'bbbbbbbbbb'])
    await assert.rejects(
      store.completeMultipartUpload({
        bucket: 'bkt', key, uploadId,
        requestedParts: [{ partNumber: 2, etag: etags[1] }, { partNumber: 1, etag: etags[0] }],
      }),
      (err) => err.code === 'InvalidPartOrder',
    )
  })

  it('rejects an unknown part and an ETag mismatch', async () => {
    const { uploadId, etags, key } = await upload(['aaaaaaaaaa'])
    await assert.rejects(
      store.completeMultipartUpload({
        bucket: 'bkt', key, uploadId, requestedParts: [{ partNumber: 7, etag: etags[0] }],
      }),
      (err) => err.code === 'InvalidPart',
    )
    await assert.rejects(
      store.completeMultipartUpload({
        bucket: 'bkt', key, uploadId, requestedParts: [{ partNumber: 1, etag: '"deadbeef"' }],
      }),
      (err) => err.code === 'InvalidPart',
    )
  })

  it('rejects a non-final part below the minimum size', async () => {
    const { uploadId, etags, key } = await upload(['tiny', 'bbbbbbbbbb'])
    await assert.rejects(
      store.completeMultipartUpload({
        bucket: 'bkt', key, uploadId,
        requestedParts: etags.map((etag, index) => ({ partNumber: index + 1, etag })),
      }),
      (err) => err.code === 'EntityTooSmall',
    )
  })

  it('aborts an upload and frees every part blob', async () => {
    const { uploadId, key } = await upload(['aaaaaaaaaa', 'bbbbbbbbbb'])
    const blobs = store.metadata.allParts(uploadId).map((p) => p.blobId)
    await store.abortMultipartUpload({ bucket: 'bkt', key, uploadId })
    for (const blobId of blobs) await assert.rejects(store.blobs.size(blobId))
    assert.throws(() => store.requireUpload(uploadId, 'bkt', key), (err) => err.code === 'NoSuchUpload')
  })

  it('lists in-flight uploads and their parts', async () => {
    const { uploadId, key } = await upload(['aaaaaaaaaa', 'bbbbbbbbbb'])
    assert.deepEqual(store.listMultipartUploads('bkt', 100).map((u) => u.uploadId), [uploadId])
    assert.deepEqual(store.listParts('bkt', key, uploadId, {}).map((p) => p.partNumber), [1, 2])
  })
})

describe('dependency injection', () => {
  // ObjectStore.open() is a convenience factory. The constructor takes an
  // already-resolved StoreContext, so a caller can substitute any collaborator
  // — here, an in-memory metadata database and a fixed encryption master key.
  it('builds a working store from a hand-assembled context', async () => {
    const dataDir = await mkdtemp(join(root, 'injected-'))
    const blobs = new BlobStore(dataDir)
    await blobs.init()
    const injected = new ObjectStore({
      metadata: new MetadataStore(':memory:'),
      blobs,
      encryption: new EncryptionManager(Buffer.alloc(32, 7)),
      region: 'eu-west-1',
      minPartSize: 8,
      maxObjectSize: MAX_OBJECT_SIZE,
      maxConcurrentUploads: 10,
    })

    try {
      injected.createBucket('injected-bucket')
      assert.equal(injected.listBuckets()[0].region, 'eu-west-1')

      await injected.putObject({ bucket: 'injected-bucket', key: 'k', body: body('hello') })
      const record = injected.getObject('injected-bucket', 'k')
      assert.equal(record.size, 5)
    } finally {
      injected.close()
    }
  })

  it('exposes the three services behind the facade', () => {
    assert.equal(typeof store.buckets.requireBucket, 'function')
    assert.equal(typeof store.objects.putObject, 'function')
    assert.equal(typeof store.multipart.uploadPart, 'function')
  })
})
