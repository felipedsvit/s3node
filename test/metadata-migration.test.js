import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, before, describe, it } from 'node:test'
import { MetadataStore, SCHEMA_VERSION } from '../dist/src/storage/metadata.js'

let root

before(async () => { root = await mkdtemp(join(tmpdir(), 's3node-migration-')) })
after(async () => { await rm(root, { recursive: true, force: true }) })

describe('metadata migrations', () => {
  it('upgrades a v5 upload table and preserves its rows atomically', () => {
    const path = join(root, 'v5.sqlite')
    const legacy = new DatabaseSync(path)
    legacy.exec(`
      CREATE TABLE uploads (
        upload_id TEXT PRIMARY KEY, bucket TEXT NOT NULL, key BLOB NOT NULL,
        initiated_at INTEGER NOT NULL, content_type TEXT, metadata TEXT,
        tags TEXT, encryption TEXT
      );
      INSERT INTO uploads VALUES ('upload-1', 'bkt', X'6b', 1000, NULL, NULL, NULL, NULL);
      PRAGMA user_version = 5;
    `)
    legacy.close()

    const metadata = new MetadataStore(path)
    try {
      assert.equal(SCHEMA_VERSION, 6)
      assert.equal(metadata.db.prepare('PRAGMA user_version').get().user_version, 6)
      const upload = metadata.getUpload('upload-1')
      assert.equal(upload.bucket, 'bkt')
      assert.equal(upload.retentionMode, null)
      assert.equal(upload.retainUntil, null)
      assert.equal(upload.legalHold, false)
    } finally {
      metadata.close()
    }
  })

  it('refuses a database created by a newer binary', () => {
    const path = join(root, 'future.sqlite')
    const future = new DatabaseSync(path)
    future.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`)
    future.close()
    assert.throws(() => new MetadataStore(path), /newer than supported/)
  })
})
