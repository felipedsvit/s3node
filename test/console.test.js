import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import { ConsoleServer } from '../dist/src/console/server.js'
import { CREDENTIAL, OTHER_CREDENTIAL, resetBuckets, startServer } from './helpers/harness.js'

let harness
let admin
let base

const auth = (cred = CREDENTIAL) =>
  'Basic ' + Buffer.from(`${cred.accessKeyId}:${cred.secretAccessKey}`).toString('base64')

async function call(path, { method = 'GET', body, credential = CREDENTIAL, headers = {} } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(credential ? { authorization: auth(credential) } : {}), ...headers },
    body,
  })
  const text = await response.text()
  let json
  try { json = JSON.parse(text) } catch { json = null }
  return { status: response.status, text, json, headers: response.headers }
}

before(async () => {
  harness = await startServer()
  admin = new ConsoleServer({
    store: harness.server.store,
    credentials: harness.server.credentials,
    region: 'us-east-1',
    version: '0.1.4',
  })
  base = await admin.listen(0, '127.0.0.1')
})

after(async () => {
  await admin.close()
  await harness.cleanup()
})

beforeEach(async () => { await resetBuckets(harness.client) })

describe('console authentication', () => {
  it('refuses an unauthenticated request', async () => {
    const response = await call('/api/buckets', { credential: null })
    assert.equal(response.status, 401)
    assert.match(response.headers.get('www-authenticate'), /^Basic realm=/)
  })

  it('refuses an unknown access key', async () => {
    const response = await call('/api/buckets', {
      credential: { accessKeyId: 'AKIDGHOST', secretAccessKey: 'whatever' },
    })
    assert.equal(response.status, 401)
  })

  it('refuses a valid key with the wrong secret', async () => {
    const response = await call('/api/buckets', {
      credential: { accessKeyId: CREDENTIAL.accessKeyId, secretAccessKey: 'wrong-secret' },
    })
    assert.equal(response.status, 401)
  })

  it('accepts any configured credential', async () => {
    assert.equal((await call('/api/buckets', { credential: OTHER_CREDENTIAL })).status, 200)
  })
})

describe('console UI', () => {
  it('serves a self-contained page with a restrictive CSP', async () => {
    const response = await call('/')
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /text\/html/)
    assert.match(response.headers.get('content-security-policy'), /default-src 'none'/)
    // Nothing may be fetched from another origin.
    assert.doesNotMatch(response.text, /https?:\/\/(?!localhost)/)
  })
})

describe('console API', () => {
  it('creates, lists and deletes a bucket', async () => {
    assert.equal((await call('/api/bucket?name=console-bucket', { method: 'POST' })).status, 201)

    const listed = await call('/api/buckets')
    assert.deepEqual(listed.json.buckets.map((b) => b.name), ['console-bucket'])

    assert.equal((await call('/api/bucket?name=console-bucket', { method: 'DELETE' })).status, 200)
    assert.deepEqual((await call('/api/buckets')).json.buckets, [])
  })

  it('round-trips an object through upload, list and download', async () => {
    await call('/api/bucket?name=console-bucket', { method: 'POST' })
    const put = await call('/api/object?bucket=console-bucket&key=notes.txt', {
      method: 'PUT', body: 'hello console',
    })
    assert.equal(put.status, 200)
    assert.equal(put.json.size, 13)

    const listed = await call('/api/objects?bucket=console-bucket')
    assert.deepEqual(listed.json.objects.map((o) => o.key), ['notes.txt'])

    const got = await call('/api/object?bucket=console-bucket&key=notes.txt')
    assert.equal(got.text, 'hello console')

    assert.equal((await call('/api/object?bucket=console-bucket&key=notes.txt', { method: 'DELETE' })).status, 200)
    assert.deepEqual((await call('/api/objects?bucket=console-bucket')).json.objects, [])
  })

  it('filters the listing by prefix', async () => {
    await call('/api/bucket?name=console-bucket', { method: 'POST' })
    for (const key of ['logs/a.txt', 'logs/b.txt', 'data/c.txt']) {
      await call(`/api/object?bucket=console-bucket&key=${encodeURIComponent(key)}`, { method: 'PUT', body: 'x' })
    }
    const listed = await call('/api/objects?bucket=console-bucket&prefix=logs/')
    assert.deepEqual(listed.json.objects.map((o) => o.key).sort(), ['logs/a.txt', 'logs/b.txt'])
  })

  it('reports server info', async () => {
    await call('/api/bucket?name=console-bucket', { method: 'POST' })
    await call('/api/object?bucket=console-bucket&key=a.bin', { method: 'PUT', body: 'abcde' })

    const info = (await call('/api/info')).json
    assert.equal(info.region, 'us-east-1')
    assert.equal(info.version, '0.1.4')
    assert.equal(info.buckets, 1)
    assert.equal(info.objects, 1)
    assert.equal(info.bytes, 5)
  })

  it('surfaces store errors with their status', async () => {
    const missing = await call('/api/object?bucket=console-bucket&key=nope.txt')
    assert.equal(missing.status, 404)
  })

  it('requires the bucket parameter', async () => {
    assert.equal((await call('/api/objects')).status, 400)
  })

  it('404s an unknown API path', async () => {
    assert.equal((await call('/api/nonsense')).status, 404)
  })
})
