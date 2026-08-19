import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { after, describe, it } from 'node:test'
import { createBackup, restoreBackup, verifyBackup } from '../dist/src/backup.js'
import { ObjectStore } from '../dist/src/storage/store.js'

const roots = []

after(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function tempPath(name) {
  const parent = await mkdtemp(join(tmpdir(), 's3node-backup-'))
  roots.push(parent)
  return join(parent, name)
}

async function objectBytes(store, key, versionId = null) {
  const record = store.getObject('backup-bucket', key, versionId)
  const encryptionKey = store.resolveEncryptionKey(record, null)
  const chunks = []
  for await (const chunk of store.createObjectStream(record, 0, record.size - 1, { encryptionKey })) chunks.push(chunk)
  return Buffer.concat(chunks)
}

describe('backup and restore drill', () => {
  it('restores SQLite, versions, multipart state, blobs, and master.key byte-for-byte', async () => {
    const source = await tempPath('source')
    const backup = await tempPath('snapshot')
    const restored = await tempPath('restored')
    const store = await ObjectStore.open({ dataDir: source, minPartSize: 1 })
    store.createBucket('backup-bucket')
    store.putBucketConfig('backup-bucket', 'versioning', { status: 'Enabled' })

    const first = await store.putObject({
      bucket: 'backup-bucket', key: 'versioned', body: Readable.from([Buffer.from('version-one')]),
    })
    const second = await store.putObject({
      bucket: 'backup-bucket', key: 'versioned', body: Readable.from([Buffer.from('version-two')]),
    })
    await store.putObject({
      bucket: 'backup-bucket', key: 'encrypted', body: Readable.from([Buffer.from('secret-bytes')]),
      encryptionRequest: { mode: 'SSE-S3', algorithm: 'AES256' },
    })

    const active = store.createMultipartUpload({ bucket: 'backup-bucket', key: 'active-upload' })
    const activePart = await store.uploadPart({
      bucket: 'backup-bucket', key: 'active-upload', uploadId: active.uploadId, partNumber: 1,
      body: Readable.from([Buffer.from('pending-part')]),
    })

    const manifest = await createBackup(source, backup)
    assert.ok(manifest.blobCount >= 4)
    assert.deepEqual(await verifyBackup(backup), manifest)
    await restoreBackup(backup, restored)
    store.close()

    const recovered = await ObjectStore.open({ dataDir: restored, minPartSize: 1 })
    assert.equal(recovered.metadata.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
    assert.deepEqual(await objectBytes(recovered, 'versioned', first.versionId), Buffer.from('version-one'))
    assert.deepEqual(await objectBytes(recovered, 'versioned', second.versionId), Buffer.from('version-two'))
    assert.deepEqual(await objectBytes(recovered, 'encrypted'), Buffer.from('secret-bytes'))
    const restoredPart = recovered.metadata.getPart(active.uploadId, 1)
    assert.equal(restoredPart.etag, activePart.etag)
    assert.deepEqual(await readFile(recovered.blobs.path(restoredPart.blobId)), Buffer.from('pending-part'))
    assert.deepEqual(await readFile(join(restored, 'master.key')), await readFile(join(source, 'master.key')))
    recovered.close()
  })

  it('rejects a checksum-corrupted snapshot before restore', async () => {
    const source = await tempPath('source')
    const backup = await tempPath('snapshot')
    const store = await ObjectStore.open({ dataDir: source })
    store.createBucket('backup-bucket')
    await store.putObject({ bucket: 'backup-bucket', key: 'key', body: Readable.from([Buffer.from('bytes')]) })
    await createBackup(source, backup)
    store.close()

    const { appendFile } = await import('node:fs/promises')
    await appendFile(join(backup, 'master.key'), 'tamper')
    await assert.rejects(verifyBackup(backup), /size mismatch|checksum mismatch/)
  })

  it('rejects a manifest entry replaced by a symlink outside the snapshot', async () => {
    const source = await tempPath('source')
    const backup = await tempPath('snapshot')
    const external = await tempPath('external-key')
    const store = await ObjectStore.open({ dataDir: source })
    store.createBucket('backup-bucket')
    await createBackup(source, backup)
    store.close()

    await writeFile(external, await readFile(join(backup, 'master.key')))
    await rm(join(backup, 'master.key'))
    await symlink(external, join(backup, 'master.key'))
    await assert.rejects(verifyBackup(backup), /must not be a symbolic link/)
  })

  it('does not follow a source master key symlink while creating a backup', async () => {
    const source = await tempPath('source')
    const backup = await tempPath('snapshot')
    const external = await tempPath('external-key')
    const store = await ObjectStore.open({ dataDir: source })
    store.createBucket('backup-bucket')
    store.close()

    await writeFile(external, await readFile(join(source, 'master.key')))
    await rm(join(source, 'master.key'))
    await symlink(external, join(source, 'master.key'))
    await assert.rejects(createBackup(source, backup), /must not be a symbolic link/)
  })
})
