import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, beforeEach, describe, it } from 'node:test'
import { allTags, resetBuckets, startServer, tag } from './helpers/harness.js'

const BUCKET = 'part-copy-bucket'

let harness
let client

before(async () => {
  harness = await startServer({ minPartSize: 16 })
  client = harness.client
})
after(async () => { await harness.cleanup() })
beforeEach(async () => {
  await resetBuckets(client)
  await client.request({ method: 'PUT', bucket: BUCKET })
})

async function beginUpload(key) {
  const started = await client.request({ method: 'POST', bucket: BUCKET, key, query: { uploads: '' } })
  return tag(started.text, 'UploadId')
}

async function copyPart(key, uploadId, partNumber, source, headers = {}) {
  return client.request({
    method: 'PUT', bucket: BUCKET, key,
    query: { uploadId, partNumber: String(partNumber) },
    headers: { 'x-amz-copy-source': source, ...headers },
  })
}

async function complete(key, uploadId, etags) {
  const parts = etags.map((etag, i) =>
    `<Part><PartNumber>${i + 1}</PartNumber><ETag>${etag}</ETag></Part>`).join('')
  return client.request({
    method: 'POST', bucket: BUCKET, key, query: { uploadId },
    body: `<CompleteMultipartUpload>${parts}</CompleteMultipartUpload>`,
  })
}

describe('UploadPartCopy', () => {
  it('copies a whole object into a part', async () => {
    const payload = randomBytes(64)
    await client.request({ method: 'PUT', bucket: BUCKET, key: 'src.bin', body: payload })

    const uploadId = await beginUpload('dst.bin')
    const copied = await copyPart('dst.bin', uploadId, 1, `/${BUCKET}/src.bin`)
    assert.equal(copied.status, 200)
    assert.match(copied.text, /<CopyPartResult[ >]/)

    const etag = tag(copied.text, 'ETag')
    assert.equal((await complete('dst.bin', uploadId, [etag])).status, 200)

    const got = await client.request({ method: 'GET', bucket: BUCKET, key: 'dst.bin' })
    assert.deepEqual(got.body, payload)
  })

  it('copies a byte range with x-amz-copy-source-range', async () => {
    const payload = randomBytes(200)
    await client.request({ method: 'PUT', bucket: BUCKET, key: 'src.bin', body: payload })

    const uploadId = await beginUpload('dst.bin')
    const copied = await copyPart('dst.bin', uploadId, 1, `/${BUCKET}/src.bin`,
      { 'x-amz-copy-source-range': 'bytes=50-149' })
    assert.equal(copied.status, 200)

    await complete('dst.bin', uploadId, [tag(copied.text, 'ETag')])
    const got = await client.request({ method: 'GET', bucket: BUCKET, key: 'dst.bin' })
    assert.deepEqual(got.body, payload.subarray(50, 150))
  })

  it('assembles an object from several copied ranges', async () => {
    const payload = randomBytes(150)
    await client.request({ method: 'PUT', bucket: BUCKET, key: 'src.bin', body: payload })

    const uploadId = await beginUpload('dst.bin')
    const etags = []
    for (const [i, range] of [[0, 99], [100, 149]].entries()) {
      const copied = await copyPart('dst.bin', uploadId, i + 1, `/${BUCKET}/src.bin`,
        { 'x-amz-copy-source-range': `bytes=${range[0]}-${range[1]}` })
      assert.equal(copied.status, 200)
      etags.push(tag(copied.text, 'ETag'))
    }
    await complete('dst.bin', uploadId, etags)

    const got = await client.request({ method: 'GET', bucket: BUCKET, key: 'dst.bin' })
    assert.deepEqual(got.body, payload)
  })

  it('mixes a copied part with an uploaded one', async () => {
    const head = randomBytes(64)
    const tailBody = randomBytes(32)
    await client.request({ method: 'PUT', bucket: BUCKET, key: 'src.bin', body: head })

    const uploadId = await beginUpload('dst.bin')
    const copied = await copyPart('dst.bin', uploadId, 1, `/${BUCKET}/src.bin`)
    const uploaded = await client.request({
      method: 'PUT', bucket: BUCKET, key: 'dst.bin',
      query: { uploadId, partNumber: '2' }, body: tailBody,
    })
    await complete('dst.bin', uploadId, [tag(copied.text, 'ETag'), uploaded.headers.etag])

    const got = await client.request({ method: 'GET', bucket: BUCKET, key: 'dst.bin' })
    assert.deepEqual(got.body, Buffer.concat([head, tailBody]))
  })

  it('rejects a malformed copy-source-range', async () => {
    await client.request({ method: 'PUT', bucket: BUCKET, key: 'src.bin', body: 'x'.repeat(40) })
    const uploadId = await beginUpload('dst.bin')
    const copied = await copyPart('dst.bin', uploadId, 1, `/${BUCKET}/src.bin`,
      { 'x-amz-copy-source-range': 'bytes=-20' })
    assert.equal(copied.status, 400)
    assert.equal(tag(copied.text, 'Code'), 'InvalidArgument')
  })

  it('rejects a range past the end of the source', async () => {
    await client.request({ method: 'PUT', bucket: BUCKET, key: 'src.bin', body: 'x'.repeat(40) })
    const uploadId = await beginUpload('dst.bin')
    const copied = await copyPart('dst.bin', uploadId, 1, `/${BUCKET}/src.bin`,
      { 'x-amz-copy-source-range': 'bytes=100-200' })
    assert.equal(copied.status, 400)
  })

  it('reports NoSuchKey for a missing source', async () => {
    const uploadId = await beginUpload('dst.bin')
    const copied = await copyPart('dst.bin', uploadId, 1, `/${BUCKET}/absent.bin`)
    assert.equal(copied.status, 404)
    assert.equal(tag(copied.text, 'Code'), 'NoSuchKey')
  })

  it('reports NoSuchUpload for an unknown uploadId', async () => {
    await client.request({ method: 'PUT', bucket: BUCKET, key: 'src.bin', body: 'data' })
    const copied = await copyPart('dst.bin', 'not-a-real-upload', 1, `/${BUCKET}/src.bin`)
    assert.equal(copied.status, 404)
    assert.equal(tag(copied.text, 'Code'), 'NoSuchUpload')
  })
})
