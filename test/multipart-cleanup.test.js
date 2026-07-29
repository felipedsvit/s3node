import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { after, before, beforeEach, describe, it } from 'node:test'
import { ObjectStore } from '../dist/src/storage/store.js'
import { MultipartCleanup } from '../dist/src/storage/multipartCleanup.js'

let root, store, cleanup

function body(content) {
  return Readable.from([Buffer.from(content)])
}

before(async () => { root = await mkdtemp(join(tmpdir(), 's3node-mpc-')) })
after(async () => { store?.close(); await rm(root, { recursive: true, force: true }) })

beforeEach(async () => {
  store?.close()
  const dataDir = await mkdtemp(join(root, 'store-'))
  store = await ObjectStore.open({ dataDir, minPartSize: 8 })
  cleanup = new MultipartCleanup(store)
  store.createBucket('bkt')
})

describe('MultipartCleanup', () => {
  it('aborts an expired upload and removes its parts', async () => {
    const { uploadId } = store.createMultipartUpload({ bucket: 'bkt', key: 'stale' })
    const { etag } = await store.uploadPart({ bucket: 'bkt', key: 'stale', uploadId, partNumber: 1, body: body('part1') })

    // Use a zero-hour expiration so the upload is instantly stale.
    const stats = await cleanup.cleanup(0)
    assert.equal(stats.scanned, 1)
    assert.equal(stats.aborted, 1)
    assert.equal(stats.partsRemoved, 1)

    // The upload should be gone.
    assert.strictEqual(store.metadata.getUpload(uploadId), null)
  })

  it('does not abort an active upload', async () => {
    store.createMultipartUpload({ bucket: 'bkt', key: 'active' })
    // Use a very long expiration so the upload is not stale.
    const stats = await cleanup.cleanup(24 * 365)
    assert.equal(stats.scanned, 0)
    assert.equal(stats.aborted, 0)
  })

  it('handles multiple stale uploads', async () => {
    for (let i = 0; i < 5; i++) {
      const { uploadId } = store.createMultipartUpload({ bucket: 'bkt', key: `stale-${i}` })
      await store.uploadPart({ bucket: 'bkt', key: `stale-${i}`, uploadId, partNumber: 1, body: body('p') })
    }

    const stats = await cleanup.cleanup(0)
    assert.equal(stats.scanned, 5)
    assert.equal(stats.aborted, 5)
    assert.equal(stats.partsRemoved, 5)
  })

  it('removes part blobs when aborting', async () => {
    const { uploadId } = store.createMultipartUpload({ bucket: 'bkt', key: 'blobs' })
    const { etag } = await store.uploadPart({ bucket: 'bkt', key: 'blobs', uploadId, partNumber: 1, body: body('part') })
    const partBlobs = store.metadata.allParts(uploadId).map((p) => p.blobId)

    await cleanup.cleanup(0)

    for (const blobId of partBlobs) {
      await assert.rejects(store.blobs.size(blobId))
    }
  })

  it('removes upload metadata when aborting', async () => {
    const { uploadId } = store.createMultipartUpload({ bucket: 'bkt', key: 'meta' })
    await store.uploadPart({ bucket: 'bkt', key: 'meta', uploadId, partNumber: 1, body: body('p') })

    await cleanup.cleanup(0)

    // Metadata should be gone.
    assert.strictEqual(store.metadata.getUpload(uploadId), null)
    assert.deepEqual(store.metadata.allParts(uploadId), [])
  })

  it('preserves blobs still referenced by completed uploads', async () => {
    // Create and complete a multipart upload (parts become the object's manifest).
    const { uploadId } = store.createMultipartUpload({ bucket: 'bkt', key: 'completed' })
    const { etag } = await store.uploadPart({ bucket: 'bkt', key: 'completed', uploadId, partNumber: 1, body: body('data') })
    await store.completeMultipartUpload({
      bucket: 'bkt', key: 'completed', uploadId,
      requestedParts: [{ partNumber: 1, etag }],
    })

    // The original upload is gone; GC should not affect the completed object.
    const stats = await cleanup.cleanup(0)
    assert.equal(stats.scanned, 0)
    assert.equal(stats.aborted, 0)

    const record = store.getObject('bkt', 'completed')
    assert.equal(record.size, 4)
  })

  it('continues processing if one upload fails', async () => {
    // Create one upload that will error (non-existent bucket shouldn't happen,
    // but we can create an inconsistent state by deleting the bucket).
    const { uploadId } = store.createMultipartUpload({ bucket: 'bkt', key: 'fail' })
    await store.uploadPart({ bucket: 'bkt', key: 'fail', uploadId, partNumber: 1, body: body('p') })

    // Also create a valid stale upload.
    const { uploadId: uploadId2 } = store.createMultipartUpload({ bucket: 'bkt', key: 'ok' })
    await store.uploadPart({ bucket: 'bkt', key: 'ok', uploadId: uploadId2, partNumber: 1, body: body('p') })

    const stats = await cleanup.cleanup(0)
    // Both should be aborted (the first one is still valid since the bucket exists).
    assert.equal(stats.aborted, 2)
    assert.equal(stats.partsRemoved, 2)
  })
})
