import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import { resetBuckets, startServer } from './helpers/harness.js'

const BUCKET = 'quota-bucket'

let harness
let client
let store

before(async () => {
  harness = await startServer()
  client = harness.client
  store = harness.server.store
})

after(async () => { await harness.cleanup() })

beforeEach(async () => {
  await resetBuckets(client)
  await client.request({ method: 'PUT', bucket: BUCKET })
})

describe('bucket quotas', () => {
  it('allows writes under quota', async () => {
    store.putBucketConfig(BUCKET, 'quota', { maxObjects: 2, maxBucketSize: 1000 })
    const response = await client.request({ method: 'PUT', bucket: BUCKET, key: 'a', body: 'hello' })
    assert.equal(response.status, 200)
  })

  it('rejects a new object once maxObjects is reached', async () => {
    store.putBucketConfig(BUCKET, 'quota', { maxObjects: 1 })
    const first = await client.request({ method: 'PUT', bucket: BUCKET, key: 'a', body: 'hello' })
    assert.equal(first.status, 200)

    const second = await client.request({ method: 'PUT', bucket: BUCKET, key: 'b', body: 'world' })
    assert.equal(second.status, 403)
    assert.match(second.text, /QuotaExceeded/)
  })

  it('rejects a write that would exceed maxBucketSize', async () => {
    store.putBucketConfig(BUCKET, 'quota', { maxBucketSize: 5 })
    const response = await client.request({ method: 'PUT', bucket: BUCKET, key: 'too-big', body: 'this is more than five bytes' })
    assert.equal(response.status, 403)
    assert.match(response.text, /QuotaExceeded/)
  })

  it('does not leave a blob behind when a quota rejection happens', async () => {
    store.putBucketConfig(BUCKET, 'quota', { maxBucketSize: 5 })
    await client.request({ method: 'PUT', bucket: BUCKET, key: 'too-big', body: 'this is more than five bytes' })
    const listing = store.listObjects(BUCKET, { maxKeys: 10 })
    assert.deepEqual(listing.contents, [])
  })

  it('rejects a multipart completion that would exceed maxBucketSize', async () => {
    store.putBucketConfig(BUCKET, 'quota', { maxBucketSize: 5 })
    const created = await client.request({ method: 'POST', bucket: BUCKET, key: 'mp', query: { uploads: '' } })
    const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(created.text)[1]
    const part = await client.request({
      method: 'PUT', bucket: BUCKET, key: 'mp', query: { partNumber: '1', uploadId }, body: 'x'.repeat(16),
    })
    assert.equal(part.status, 200)

    const complete = await client.request({
      method: 'POST', bucket: BUCKET, key: 'mp', query: { uploadId },
      body: `<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>${part.headers.etag}</ETag></Part></CompleteMultipartUpload>`,
    })
    assert.equal(complete.status, 403)
    assert.match(complete.text, /QuotaExceeded/)
  })

  it('ignores quota entirely when none is configured', async () => {
    const response = await client.request({ method: 'PUT', bucket: BUCKET, key: 'unbounded', body: 'x'.repeat(1000) })
    assert.equal(response.status, 200)
  })
})
