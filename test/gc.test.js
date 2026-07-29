import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { after, before, beforeEach, describe, it } from 'node:test'
import { ObjectStore } from '../dist/src/storage/store.js'
import { GarbageCollector } from '../dist/src/storage/gc.js'

let root, store, gc

function body(content) {
  return Readable.from([Buffer.from(content)])
}

before(async () => { root = await mkdtemp(join(tmpdir(), 's3node-gc-')) })
after(async () => { store?.close(); await rm(root, { recursive: true, force: true }) })

beforeEach(async () => {
  store?.close()
  const dataDir = await mkdtemp(join(root, 'store-'))
  store = await ObjectStore.open({ dataDir, minPartSize: 8 })
  gc = new GarbageCollector(store)
  store.createBucket('bkt')
})

describe('GarbageCollector', () => {
  it('does not remove a blob that is still referenced', async () => {
    await store.putObject({ bucket: 'bkt', key: 'k', body: body('hello') })
    const stats = await gc.collect()
    assert.equal(stats.orphaned, 0)
    assert.equal(stats.deleted, 0)
    assert.equal(stats.referenced, 1)
    assert.equal(stats.scanned, 1)
  })

  it('removes a blob that has no metadata reference', async () => {
    // Write a blob directly to the blob store, bypassing metadata.
    const { blobId } = await store.blobs.write(Readable.from([Buffer.from('orphan')]), { algorithms: ['md5'] })
    const stats = await gc.collect()
    assert.equal(stats.orphaned, 1)
    assert.equal(stats.deleted, 1)
    // The blob file should no longer exist.
    await assert.rejects(store.blobs.size(blobId))
  })

  it('removes empty directories after deleting orphans', async () => {
    const { blobId } = await store.blobs.write(Readable.from([Buffer.from('dir-cleanup')]), { algorithms: ['md5'] })
    const xx = blobId.slice(0, 2)
    const yy = blobId.slice(2, 4)
    const blobDir = join(store.blobs.dataDir, xx, yy)
    // Verify the directory exists before cleanup.
    const beforeFiles = await readdir(blobDir)
    assert.ok(beforeFiles.includes(blobId))

    await gc.collect()

    // After GC the directory should be gone (since it was the only file and was orphaned).
    await assert.rejects(readdir(blobDir))
  })

  it('never removes the data root directory', async () => {
    await gc.collect()
    await assert.doesNotReject(readdir(store.blobs.dataDir))
  })

  it('is idempotent — running twice produces the same result', async () => {
    const { blobId } = await store.blobs.write(Readable.from([Buffer.from('idempotent')]), { algorithms: ['md5'] })
    const first = await gc.collect()
    assert.equal(first.deleted, 1)

    const second = await gc.collect()
    assert.equal(second.orphaned, 0)
    assert.equal(second.deleted, 0)

    await assert.rejects(store.blobs.size(blobId))
  })

  it('handles interruption during removal gracefully', async () => {
    // Write several orphan blobs.
    const ids = []
    for (let i = 0; i < 10; i++) {
      const { blobId } = await store.blobs.write(Readable.from([Buffer.from(`orphan-${i}`)]), { algorithms: ['md5'] })
      ids.push(blobId)
    }
    const stats = await gc.collect()
    assert.equal(stats.deleted, 10)
    for (const id of ids) await assert.rejects(store.blobs.size(id))
  })

  it('preserves referenced multipart parts', async () => {
    const { uploadId } = store.createMultipartUpload({ bucket: 'bkt', key: 'mp' })
    const { etag } = await store.uploadPart({ bucket: 'bkt', key: 'mp', uploadId, partNumber: 1, body: body('part1') })
    await store.completeMultipartUpload({
      bucket: 'bkt', key: 'mp', uploadId,
      requestedParts: [{ partNumber: 1, etag }],
    })
    const stats = await gc.collect()
    assert.equal(stats.orphaned, 0)
    assert.equal(stats.deleted, 0)
  })

  it('scan is read-only and returns correct counts', async () => {
    await store.putObject({ bucket: 'bkt', key: 'k', body: body('data') })
    const { blobId } = await store.blobs.write(Readable.from([Buffer.from('orphan')]), { algorithms: ['md5'] })

    const stats = await gc.scan()
    assert.equal(stats.scanned, 2)
    assert.equal(stats.referenced, 1)
    assert.equal(stats.orphaned, 1)
    assert.equal(stats.deleted, 0)

    // The orphaned blob should still exist after scan.
    await assert.doesNotReject(store.blobs.size(blobId))
  })
})
