import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import { allTags, startServer, tag, versionBlocks } from './helpers/harness.js'

const BUCKET = 'versioned-bucket'

let harness
let client

const enableVersioning = (status = 'Enabled') => client.request({
  method: 'PUT', bucket: BUCKET, query: { versioning: '' },
  body: `<VersioningConfiguration><Status>${status}</Status></VersioningConfiguration>`,
})

before(async () => {
  harness = await startServer()
  client = harness.client
})

after(async () => { await harness.cleanup() })

beforeEach(async () => {
  const listing = await client.request({ method: 'GET' })
  for (const name of allTags(listing.text, 'Name')) {
    const versions = await client.request({ method: 'GET', bucket: name, query: { versions: '' } })
    for (const entry of versionBlocks(versions.text)) {
      await client.request({
        method: 'DELETE', bucket: name, key: entry.key, query: { versionId: entry.versionId },
      })
    }
    await client.request({ method: 'DELETE', bucket: name })
  }
  await client.request({ method: 'PUT', bucket: BUCKET })
})

describe('versioning configuration', () => {
  it('starts unset and reports no status', async () => {
    const response = await client.request({ method: 'GET', bucket: BUCKET, query: { versioning: '' } })
    assert.equal(response.status, 200)
    assert.equal(tag(response.text, 'Status'), undefined)
  })

  it('can be enabled and suspended', async () => {
    assert.equal((await enableVersioning('Enabled')).status, 200)
    let response = await client.request({ method: 'GET', bucket: BUCKET, query: { versioning: '' } })
    assert.equal(tag(response.text, 'Status'), 'Enabled')

    assert.equal((await enableVersioning('Suspended')).status, 200)
    response = await client.request({ method: 'GET', bucket: BUCKET, query: { versioning: '' } })
    assert.equal(tag(response.text, 'Status'), 'Suspended')
  })

  it('rejects an invalid status', async () => {
    const response = await enableVersioning('Nonsense')
    assert.equal(response.status, 400)
  })
})

describe('versioned objects', () => {
  beforeEach(async () => { await enableVersioning('Enabled') })

  it('keeps every version and returns the newest by default', async () => {
    const first = await client.request({ method: 'PUT', bucket: BUCKET, key: 'k', body: 'v1' })
    const second = await client.request({ method: 'PUT', bucket: BUCKET, key: 'k', body: 'v2' })
    const v1 = first.headers['x-amz-version-id']
    const v2 = second.headers['x-amz-version-id']
    assert.ok(v1 && v2 && v1 !== v2)

    const latest = await client.request({ method: 'GET', bucket: BUCKET, key: 'k' })
    assert.equal(latest.text, 'v2')
    assert.equal(latest.headers['x-amz-version-id'], v2)

    const older = await client.request({
      method: 'GET', bucket: BUCKET, key: 'k', query: { versionId: v1 },
    })
    assert.equal(older.text, 'v1')
  })

  it('lists versions newest-first with IsLatest set once per key', async () => {
    await client.request({ method: 'PUT', bucket: BUCKET, key: 'k', body: 'v1' })
    await client.request({ method: 'PUT', bucket: BUCKET, key: 'k', body: 'v2' })
    await client.request({ method: 'PUT', bucket: BUCKET, key: 'other', body: 'x' })

    const response = await client.request({ method: 'GET', bucket: BUCKET, query: { versions: '' } })
    assert.equal(response.status, 200)
    const entries = versionBlocks(response.text)
    assert.deepEqual(entries.map((entry) => entry.key), ['k', 'k', 'other'])
    assert.deepEqual(entries.map((entry) => entry.isLatest), [true, false, true])
  })

  it('writes a delete marker instead of removing data', async () => {
    const put = await client.request({ method: 'PUT', bucket: BUCKET, key: 'k', body: 'payload' })
    const versionId = put.headers['x-amz-version-id']

    const deleted = await client.request({ method: 'DELETE', bucket: BUCKET, key: 'k' })
    assert.equal(deleted.status, 204)
    assert.equal(deleted.headers['x-amz-delete-marker'], 'true')

    const missing = await client.request({ method: 'GET', bucket: BUCKET, key: 'k' })
    assert.equal(missing.status, 404)
    assert.equal(missing.headers['x-amz-delete-marker'], 'true')

    // The data is still reachable by version id.
    const older = await client.request({
      method: 'GET', bucket: BUCKET, key: 'k', query: { versionId },
    })
    assert.equal(older.text, 'payload')
  })

  it('reports 405 when a delete marker is addressed directly', async () => {
    await client.request({ method: 'PUT', bucket: BUCKET, key: 'k', body: 'payload' })
    const deleted = await client.request({ method: 'DELETE', bucket: BUCKET, key: 'k' })
    const markerVersion = deleted.headers['x-amz-version-id']

    const response = await client.request({
      method: 'GET', bucket: BUCKET, key: 'k', query: { versionId: markerVersion },
    })
    assert.equal(response.status, 405)
  })

  it('restores the previous version when a delete marker is removed', async () => {
    await client.request({ method: 'PUT', bucket: BUCKET, key: 'k', body: 'payload' })
    const deleted = await client.request({ method: 'DELETE', bucket: BUCKET, key: 'k' })
    const markerVersion = deleted.headers['x-amz-version-id']

    await client.request({
      method: 'DELETE', bucket: BUCKET, key: 'k', query: { versionId: markerVersion },
    })
    const restored = await client.request({ method: 'GET', bucket: BUCKET, key: 'k' })
    assert.equal(restored.status, 200)
    assert.equal(restored.text, 'payload')
  })

  it('permanently removes a specific version and promotes the next newest', async () => {
    const first = await client.request({ method: 'PUT', bucket: BUCKET, key: 'k', body: 'v1' })
    const second = await client.request({ method: 'PUT', bucket: BUCKET, key: 'k', body: 'v2' })

    const response = await client.request({
      method: 'DELETE', bucket: BUCKET, key: 'k',
      query: { versionId: second.headers['x-amz-version-id'] },
    })
    assert.equal(response.status, 204)

    const latest = await client.request({ method: 'GET', bucket: BUCKET, key: 'k' })
    assert.equal(latest.text, 'v1')
    assert.equal(latest.headers['x-amz-version-id'], first.headers['x-amz-version-id'])
  })

  it('hides non-current versions from ListObjectsV2', async () => {
    await client.request({ method: 'PUT', bucket: BUCKET, key: 'k', body: 'v1' })
    await client.request({ method: 'PUT', bucket: BUCKET, key: 'k', body: 'v2' })
    const response = await client.request({
      method: 'GET', bucket: BUCKET, query: { 'list-type': '2' },
    })
    assert.deepEqual(allTags(response.text, 'Key'), ['k'])
  })

  it('hides delete-marked keys from ListObjectsV2 but shows them in ListVersions', async () => {
    await client.request({ method: 'PUT', bucket: BUCKET, key: 'k', body: 'v1' })
    await client.request({ method: 'DELETE', bucket: BUCKET, key: 'k' })

    const listing = await client.request({ method: 'GET', bucket: BUCKET, query: { 'list-type': '2' } })
    assert.deepEqual(allTags(listing.text, 'Key'), [])

    const versions = await client.request({ method: 'GET', bucket: BUCKET, query: { versions: '' } })
    const entries = versionBlocks(versions.text)
    assert.equal(entries.filter((entry) => entry.type === 'DeleteMarker').length, 1)
    assert.equal(entries.filter((entry) => entry.type === 'Version').length, 1)
  })

  it('reports NoSuchVersion for an unknown version id', async () => {
    await client.request({ method: 'PUT', bucket: BUCKET, key: 'k', body: 'v1' })
    const response = await client.request({
      method: 'GET', bucket: BUCKET, key: 'k', query: { versionId: 'does-not-exist' },
    })
    assert.equal(response.status, 404)
    assert.equal(tag(response.text, 'Code'), 'NoSuchVersion')
  })

  it('pages versions on the key and version-id markers', async () => {
    for (let index = 0; index < 5; index++) {
      await client.request({ method: 'PUT', bucket: BUCKET, key: 'k', body: `v${index}` })
    }
    await client.request({ method: 'PUT', bucket: BUCKET, key: 'z', body: 'z' })

    const seen = []
    let keyMarker = ''
    let versionIdMarker = ''
    for (let page = 0; page < 20; page++) {
      const query = { versions: '', 'max-keys': '2' }
      if (keyMarker) query['key-marker'] = keyMarker
      if (versionIdMarker) query['version-id-marker'] = versionIdMarker
      const response = await client.request({ method: 'GET', bucket: BUCKET, query })
      seen.push(...versionBlocks(response.text).map((entry) => `${entry.key}:${entry.versionId}`))
      if (tag(response.text, 'IsTruncated') !== 'true') break
      keyMarker = tag(response.text, 'NextKeyMarker')
      versionIdMarker = tag(response.text, 'NextVersionIdMarker')
    }

    assert.equal(seen.length, 6, 'every version must appear exactly once')
    assert.equal(new Set(seen).size, 6, 'pagination must not repeat a version')
  })

  it('versions a multipart upload', async () => {
    const create = await client.request({
      method: 'POST', bucket: BUCKET, key: 'big', query: { uploads: '' },
    })
    const uploadId = tag(create.text, 'UploadId')
    const part = await client.request({
      method: 'PUT', bucket: BUCKET, key: 'big',
      query: { partNumber: '1', uploadId }, body: 'multipart payload',
    })
    const complete = await client.request({
      method: 'POST', bucket: BUCKET, key: 'big', query: { uploadId },
      body: `<CompleteMultipartUpload><Part><PartNumber>1</PartNumber>` +
            `<ETag>${part.headers.etag}</ETag></Part></CompleteMultipartUpload>`,
    })
    assert.equal(complete.status, 200)
    assert.ok(complete.headers['x-amz-version-id'])
  })
})

describe('suspended versioning', () => {
  it('overwrites the null version while keeping older ones', async () => {
    await enableVersioning('Enabled')
    const versioned = await client.request({ method: 'PUT', bucket: BUCKET, key: 'k', body: 'kept' })
    const keptVersion = versioned.headers['x-amz-version-id']

    await enableVersioning('Suspended')
    await client.request({ method: 'PUT', bucket: BUCKET, key: 'k', body: 'null-1' })
    await client.request({ method: 'PUT', bucket: BUCKET, key: 'k', body: 'null-2' })

    const latest = await client.request({ method: 'GET', bucket: BUCKET, key: 'k' })
    assert.equal(latest.text, 'null-2')

    const older = await client.request({
      method: 'GET', bucket: BUCKET, key: 'k', query: { versionId: keptVersion },
    })
    assert.equal(older.text, 'kept')

    const versions = await client.request({ method: 'GET', bucket: BUCKET, query: { versions: '' } })
    // The two suspended writes collapse into a single `null` version.
    assert.equal(versionBlocks(versions.text).length, 2)
  })
})
