import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { DatabaseSync } from 'node:sqlite'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { ObjectStore } from '../dist/src/storage/store.js'

const roots = []
const worker = fileURLToPath(new URL('./fixtures/crash-worker.mjs', import.meta.url))

after(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), 's3node-crash-'))
  roots.push(root)
  return root
}

async function crash(point, action, dataDir, payload = '') {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker, action, dataDir, payload], {
      env: {
        ...process.env,
        S3NODE_ENABLE_FAULT_INJECTION: '1',
        S3NODE_FAULT_POINT: point,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal, stderr }))
  })
  assert.equal(result.signal, 'SIGKILL', `${point} did not fire: ${JSON.stringify(result)}`)
}

async function bytes(store, bucket, key) {
  const record = store.getObject(bucket, key)
  const chunks = []
  for await (const chunk of store.createObjectStream(record)) chunks.push(chunk)
  return Buffer.concat(chunks)
}

function assertSqliteOk(store) {
  const row = store.metadata.db.prepare('PRAGMA integrity_check').get()
  assert.equal(row.integrity_check, 'ok')
}

async function bootstrapObject() {
  const root = await tempRoot()
  const store = await ObjectStore.open({ dataDir: root, minPartSize: 1 })
  store.createBucket('crash-bucket')
  await store.putObject({ bucket: 'crash-bucket', key: 'key', body: Readable.from([Buffer.from('old-bytes')]) })
  store.close()
  return root
}

describe('SIGKILL crash recovery', { skip: process.platform === 'win32' }, () => {
  for (const point of [
    'blob:after-file-fsync',
    'blob:after-publish',
    'write:after-blob',
    'put:after-blob',
  ]) {
    it(`preserves the previous object at ${point}`, async () => {
      const root = await bootstrapObject()
      await crash(point, 'put', root, `new-bytes-${point}`)

      const recovered = await ObjectStore.open({ dataDir: root, minPartSize: 1 })
      assertSqliteOk(recovered)
      assert.equal((await bytes(recovered, 'crash-bucket', 'key')).toString(), 'old-bytes')
      recovered.close()
    })
  }

  for (const point of ['metadata:after-commit', 'put:after-metadata']) {
    it(`recovers the committed replacement at ${point}`, async () => {
      const root = await bootstrapObject()
      const expected = `new-bytes-${point}`
      await crash(point, 'put', root, expected)

      const recovered = await ObjectStore.open({ dataDir: root, minPartSize: 1 })
      assertSqliteOk(recovered)
      assert.equal((await bytes(recovered, 'crash-bucket', 'key')).toString(), expected)
      recovered.close()
    })
  }

  for (const [point, committed] of [
    ['multipart-part:after-blob', false],
    ['multipart-part:after-metadata', true],
  ]) {
    it(`recovers multipart part state at ${point}`, async () => {
      const root = await tempRoot()
      const store = await ObjectStore.open({ dataDir: root, minPartSize: 1 })
      store.createBucket('crash-bucket')
      const { uploadId } = store.createMultipartUpload({ bucket: 'crash-bucket', key: 'multipart' })
      store.close()

      await crash(point, 'part', root, JSON.stringify({ uploadId, partNumber: 1, body: 'part-one' }))
      const recovered = await ObjectStore.open({ dataDir: root, minPartSize: 1 })
      assertSqliteOk(recovered)
      const part = recovered.metadata.getPart(uploadId, 1)
      assert.equal(Boolean(part), committed)
      if (part) assert.deepEqual(await readFile(recovered.blobs.path(part.blobId)), Buffer.from('part-one'))
      recovered.close()
    })
  }

  it('recovers a committed multipart object byte-for-byte', async () => {
    const root = await tempRoot()
    const store = await ObjectStore.open({ dataDir: root, minPartSize: 1 })
    store.createBucket('crash-bucket')
    const { uploadId } = store.createMultipartUpload({ bucket: 'crash-bucket', key: 'multipart' })
    const first = await store.uploadPart({
      bucket: 'crash-bucket', key: 'multipart', uploadId, partNumber: 1,
      body: Readable.from([Buffer.from('part-one')]),
    })
    const second = await store.uploadPart({
      bucket: 'crash-bucket', key: 'multipart', uploadId, partNumber: 2,
      body: Readable.from([Buffer.from('part-two')]),
    })
    store.close()

    await crash('multipart-complete:after-metadata', 'complete', root, JSON.stringify({
      uploadId,
      requestedParts: [
        { partNumber: 1, etag: first.etag },
        { partNumber: 2, etag: second.etag },
      ],
    }))
    const recovered = await ObjectStore.open({ dataDir: root, minPartSize: 1 })
    assertSqliteOk(recovered)
    assert.deepEqual(await bytes(recovered, 'crash-bucket', 'multipart'), Buffer.from('part-onepart-two'))
    recovered.close()
  })

  it('rolls back an interrupted v5 to v6 migration and retries cleanly', async () => {
    const root = await tempRoot()
    const dbPath = join(root, 'metadata.sqlite')
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE uploads (
        upload_id TEXT PRIMARY KEY, bucket TEXT NOT NULL, key BLOB NOT NULL,
        initiated_at INTEGER NOT NULL, content_type TEXT, metadata TEXT, tags TEXT, encryption TEXT
      );
      INSERT INTO uploads VALUES ('u1', 'crash-bucket', x'6b6579', 123, NULL, NULL, NULL, NULL);
      PRAGMA user_version = 5;
    `)
    db.close()

    await crash('migration:v5-v6:after-alter', 'migrate', dbPath)
    const recovered = new DatabaseSync(dbPath)
    assert.equal(recovered.prepare('PRAGMA user_version').get().user_version, 5)
    const columns = recovered.prepare('PRAGMA table_info(uploads)').all().map((row) => row.name)
    assert.equal(columns.includes('retention_mode'), false)
    recovered.close()

    const { MetadataStore } = await import('../dist/src/storage/metadata.js')
    const metadata = new MetadataStore(dbPath)
    assert.equal(metadata.getUpload('u1').key.toString(), 'key')
    assert.equal(metadata.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
    metadata.close()
  })

  for (const point of ['gc:before-delete', 'gc:after-delete']) {
    it(`keeps referenced data intact at ${point}`, async () => {
      const root = await bootstrapObject()
      const store = await ObjectStore.open({ dataDir: root, minPartSize: 1 })
      await store.blobs.write(Readable.from([randomBytes(128)]))
      store.close()

      await crash(point, 'gc', root)
      const recovered = await ObjectStore.open({ dataDir: root, minPartSize: 1 })
      assertSqliteOk(recovered)
      assert.equal((await bytes(recovered, 'crash-bucket', 'key')).toString(), 'old-bytes')
      recovered.close()
    })
  }
})
