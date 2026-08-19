import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createServer as createHttpServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { createServer } from '../dist/src/index.js'
import { MetadataStore } from '../dist/src/storage/metadata.js'
import { CREDENTIAL } from './helpers/harness.js'

function cli(...args) {
  return spawnSync(process.execPath, ['dist/bin/s3node.js', ...args], { encoding: 'utf8' })
}

describe('CLI validation', () => {
  it('reports the package version', () => {
    const result = cli('--version')
    assert.equal(result.status, 0)
    assert.equal(result.stdout, '0.1.11\n')
    assert.equal(result.stderr, '')
  })

  it('documents operational limits and timeouts', () => {
    const result = cli('--help')
    assert.equal(result.status, 0)
    assert.match(result.stdout, /--max-concurrent-writes/)
    assert.match(result.stdout, /--rate-limit/)
    assert.match(result.stdout, /--request-timeout-ms/)
    assert.match(result.stdout, /--version/)
  })

  it('rejects invalid ports without starting a listener', () => {
    const result = cli('--port', '70000')
    assert.equal(result.status, 1)
    assert.match(result.stderr, /integer from 0 through 65535/)
  })

  it('parses bare --cluster and rejects an unshareable ephemeral port', () => {
    const result = cli('--cluster', '--port', '0')
    assert.equal(result.status, 1)
    assert.match(result.stderr, /cannot be used with --cluster/)
  })
})

describe('server startup cleanup', () => {
  it('closes the metadata store when the listener cannot bind', async () => {
    const occupied = createHttpServer()
    await new Promise((resolve) => occupied.listen(0, '127.0.0.1', resolve))
    const port = occupied.address().port
    const root = await mkdtemp(join(tmpdir(), 's3node-listen-failure-'))
    const originalClose = MetadataStore.prototype.close
    let closeCalls = 0
    MetadataStore.prototype.close = function (...args) {
      closeCalls++
      return originalClose.apply(this, args)
    }

    try {
      await assert.rejects(
        createServer({ dataDir: join(root, 'data'), credentials: [CREDENTIAL], port }),
        (err) => err.code === 'EADDRINUSE',
      )
      assert.equal(closeCalls, 1)
    } finally {
      MetadataStore.prototype.close = originalClose
      await new Promise((resolve) => occupied.close(resolve))
      await rm(root, { recursive: true, force: true })
    }
  })
})
