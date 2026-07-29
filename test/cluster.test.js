import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { clusterSupported, defaultWorkerCount } from '../dist/src/cluster.js'
import { CREDENTIAL } from './helpers/harness.js'
import { TestClient } from './helpers/client.js'

describe('cluster support probe', () => {
  it('reports a positive default worker count', () => {
    assert.ok(defaultWorkerCount() >= 1)
  })

  it('agrees with the running Node version about SO_REUSEPORT', () => {
    const [major, minor] = process.versions.node.split('.').map(Number)
    assert.equal(clusterSupported(), major > 22 || (major === 22 && minor >= 12))
  })
})

describe('cluster mode end to end', { skip: !clusterSupported() ? 'needs Node >= 22.12' : false }, () => {
  const WORKERS = 3
  let dataDir
  let child
  let endpoint
  let client

  before(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 's3node-cluster-'))
    child = spawn(process.execPath, [
      'dist/bin/s3node.js',
      '--data-dir', dataDir,
      '--port', '0',
      '--cluster', String(WORKERS),
      '--access-key', CREDENTIAL.accessKeyId,
      '--secret-key', CREDENTIAL.secretAccessKey,
      '--quiet',
    ], { stdio: ['ignore', 'pipe', 'pipe'] })

    endpoint = await new Promise((resolve, reject) => {
      let output = ''
      const timer = setTimeout(() => reject(new Error(`no endpoint in: ${output}`)), 20000)
      child.stdout.on('data', (chunk) => {
        output += chunk
        const match = /listening on (http:\/\/\S+)/.exec(output)
        if (match) { clearTimeout(timer); resolve(match[1]) }
      })
      child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`exited early (${code}): ${output}`)) })
    })
    client = new TestClient({ endpoint, ...CREDENTIAL })
  })

  after(async () => {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM')
      await new Promise((resolve) => child.on('exit', resolve))
    }
    await rm(dataDir, { recursive: true, force: true })
  })

  it('serves requests with several workers bound to one port', async () => {
    assert.equal((await client.request({ method: 'PUT', bucket: 'cluster-bucket' })).status, 200)
    assert.equal((await client.request({ method: 'GET' })).status, 200)
  })

  it('shares stored objects across workers', async () => {
    // Requests are spread by the kernel, so a write and its read very likely
    // land on different processes. They agree because all workers open the same
    // SQLite file in WAL mode.
    const writes = []
    for (let i = 0; i < 24; i++) {
      writes.push(client.request({
        method: 'PUT', bucket: 'cluster-bucket', key: `k${i}.txt`, body: `value-${i}`,
      }))
    }
    for (const response of await Promise.all(writes)) assert.equal(response.status, 200)

    for (let i = 0; i < 24; i++) {
      const got = await client.request({ method: 'GET', bucket: 'cluster-bucket', key: `k${i}.txt` })
      assert.equal(got.status, 200)
      assert.equal(got.body.toString(), `value-${i}`)
    }

    const listing = await client.request({
      method: 'GET', bucket: 'cluster-bucket', query: { 'list-type': '2' },
    })
    assert.equal((listing.text.match(/<Key>/g) ?? []).length, 24)
  })

  it('survives concurrent writes to the same key from many workers', async () => {
    const attempts = await Promise.all(Array.from({ length: 16 }, (_, i) =>
      client.request({ method: 'PUT', bucket: 'cluster-bucket', key: 'contended.txt', body: `w${i}` })))
    for (const response of attempts) assert.equal(response.status, 200)

    const got = await client.request({ method: 'GET', bucket: 'cluster-bucket', key: 'contended.txt' })
    assert.equal(got.status, 200)
    assert.match(got.body.toString(), /^w\d+$/)
  })

  it('shuts every worker down on SIGTERM', async () => {
    child.kill('SIGTERM')
    const code = await new Promise((resolve) => child.on('exit', resolve))
    assert.ok(code === 0 || code === null)
  })
})
