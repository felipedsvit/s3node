import assert from 'node:assert/strict'
import { createServer as createHttpServer } from 'node:http'
import { after, before, beforeEach, describe, it } from 'node:test'
import { runLifecycle } from '../dist/src/features/lifecycle.js'
import { DAY_MS } from '../dist/src/features/lifecycle.js'
import { allTags, resetBuckets, startServer, tag } from './helpers/harness.js'

const BUCKET = 'feature-bucket'

let harness
let client

before(async () => {
  harness = await startServer()
  client = harness.client
})

after(async () => { await harness.cleanup() })

beforeEach(async () => {
  await resetBuckets(client)
  await client.request({ method: 'PUT', bucket: BUCKET })
})

/* ---------------------------------- CORS --------------------------------- */

describe('CORS', () => {
  const CONFIG =
    '<CORSConfiguration><CORSRule>' +
    '<AllowedOrigin>https://app.example.com</AllowedOrigin>' +
    '<AllowedOrigin>https://*.trusted.net</AllowedOrigin>' +
    '<AllowedMethod>GET</AllowedMethod><AllowedMethod>PUT</AllowedMethod>' +
    '<AllowedHeader>content-type</AllowedHeader><AllowedHeader>x-amz-date</AllowedHeader>' +
    '<ExposeHeader>ETag</ExposeHeader><MaxAgeSeconds>3000</MaxAgeSeconds>' +
    '</CORSRule></CORSConfiguration>'

  const setCors = () => client.request({
    method: 'PUT', bucket: BUCKET, query: { cors: '' }, body: CONFIG,
  })

  it('round-trips the configuration', async () => {
    assert.equal((await setCors()).status, 200)
    const stored = await client.request({ method: 'GET', bucket: BUCKET, query: { cors: '' } })
    assert.equal(stored.status, 200)
    assert.deepEqual(allTags(stored.text, 'AllowedOrigin'),
      ['https://app.example.com', 'https://*.trusted.net'])
    assert.equal(tag(stored.text, 'MaxAgeSeconds'), '3000')
  })

  it('answers a preflight without authentication', async () => {
    await setCors()
    // Browsers never attach credentials to a preflight, so it must work unsigned.
    const response = await client.send({
      method: 'OPTIONS', path: `/${BUCKET}/some-key`,
      headers: {
        origin: 'https://app.example.com',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'content-type',
      },
    })
    assert.equal(response.status, 200)
    assert.equal(response.headers['access-control-allow-origin'], 'https://app.example.com')
    assert.match(response.headers['access-control-allow-methods'], /GET/)
    assert.equal(response.headers['access-control-allow-headers'], 'content-type')
    assert.equal(response.headers['access-control-max-age'], '3000')
  })

  it('matches a wildcard origin', async () => {
    await setCors()
    const response = await client.send({
      method: 'OPTIONS', path: `/${BUCKET}/k`,
      headers: { origin: 'https://team.trusted.net', 'access-control-request-method': 'GET' },
    })
    assert.equal(response.status, 200)
    assert.equal(response.headers['access-control-allow-origin'], 'https://team.trusted.net')
  })

  it('refuses a disallowed origin, method or header', async () => {
    await setCors()
    const cases = [
      { origin: 'https://evil.example.com', 'access-control-request-method': 'GET' },
      { origin: 'https://app.example.com', 'access-control-request-method': 'DELETE' },
      {
        origin: 'https://app.example.com',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'x-secret',
      },
    ]
    for (const headers of cases) {
      const response = await client.send({ method: 'OPTIONS', path: `/${BUCKET}/k`, headers })
      assert.equal(response.status, 403, JSON.stringify(headers))
      assert.equal(tag(response.text, 'Code'), 'AccessForbidden')
    }
  })

  it('adds CORS headers to an actual request', async () => {
    await setCors()
    await client.request({ method: 'PUT', bucket: BUCKET, key: 'k', body: 'x' })
    const response = await client.request({
      method: 'GET', bucket: BUCKET, key: 'k', headers: { origin: 'https://app.example.com' },
    })
    assert.equal(response.status, 200)
    assert.equal(response.headers['access-control-allow-origin'], 'https://app.example.com')
    assert.equal(response.headers['access-control-expose-headers'], 'ETag')
    assert.match(response.headers.vary, /Origin/)
  })

  it('always sets Vary so caches do not cross origins', async () => {
    await setCors()
    await client.request({ method: 'PUT', bucket: BUCKET, key: 'k', body: 'x' })
    const response = await client.request({
      method: 'GET', bucket: BUCKET, key: 'k', headers: { origin: 'https://not-allowed.example' },
    })
    assert.equal(response.status, 200)
    assert.equal(response.headers['access-control-allow-origin'], undefined)
    assert.match(response.headers.vary, /Origin/)
  })

  it('reports 404 when no configuration exists, and deletes cleanly', async () => {
    const missing = await client.request({ method: 'GET', bucket: BUCKET, query: { cors: '' } })
    assert.equal(missing.status, 404)
    assert.equal(tag(missing.text, 'Code'), 'NoSuchCORSConfiguration')

    await setCors()
    assert.equal((await client.request({
      method: 'DELETE', bucket: BUCKET, query: { cors: '' },
    })).status, 204)
    assert.equal((await client.request({
      method: 'GET', bucket: BUCKET, query: { cors: '' },
    })).status, 404)
  })
})

/* --------------------------------- tagging -------------------------------- */

describe('tagging', () => {
  it('stores object tags from the x-amz-tagging header', async () => {
    await client.request({
      method: 'PUT', bucket: BUCKET, key: 'k', body: 'x',
      headers: { 'x-amz-tagging': 'env=prod&team=platform' },
    })
    const response = await client.request({
      method: 'GET', bucket: BUCKET, key: 'k', query: { tagging: '' },
    })
    assert.equal(response.status, 200)
    assert.deepEqual(allTags(response.text, 'Key'), ['env', 'team'])
    assert.deepEqual(allTags(response.text, 'Value'), ['prod', 'platform'])
  })

  it('reports the tag count on GET', async () => {
    await client.request({
      method: 'PUT', bucket: BUCKET, key: 'k', body: 'x', headers: { 'x-amz-tagging': 'a=1&b=2' },
    })
    const response = await client.request({ method: 'GET', bucket: BUCKET, key: 'k' })
    assert.equal(response.headers['x-amz-tagging-count'], '2')
  })

  it('replaces and clears object tags', async () => {
    await client.request({ method: 'PUT', bucket: BUCKET, key: 'k', body: 'x' })
    const put = await client.request({
      method: 'PUT', bucket: BUCKET, key: 'k', query: { tagging: '' },
      body: '<Tagging><TagSet><Tag><Key>stage</Key><Value>beta</Value></Tag></TagSet></Tagging>',
    })
    assert.equal(put.status, 200)

    let response = await client.request({ method: 'GET', bucket: BUCKET, key: 'k', query: { tagging: '' } })
    assert.deepEqual(allTags(response.text, 'Value'), ['beta'])

    assert.equal((await client.request({
      method: 'DELETE', bucket: BUCKET, key: 'k', query: { tagging: '' },
    })).status, 204)
    response = await client.request({ method: 'GET', bucket: BUCKET, key: 'k', query: { tagging: '' } })
    assert.deepEqual(allTags(response.text, 'Value'), [])
  })

  it('rejects more than ten object tags', async () => {
    const tags = Array.from({ length: 11 }, (_, index) => `k${index}=v`).join('&')
    const response = await client.request({
      method: 'PUT', bucket: BUCKET, key: 'k', body: 'x', headers: { 'x-amz-tagging': tags },
    })
    assert.equal(response.status, 400)
    assert.equal(tag(response.text, 'Code'), 'InvalidTag')
  })

  it('carries tags through a copy and can replace them', async () => {
    await client.request({
      method: 'PUT', bucket: BUCKET, key: 'src', body: 'x', headers: { 'x-amz-tagging': 'a=1' },
    })
    await client.request({
      method: 'PUT', bucket: BUCKET, key: 'copied',
      headers: { 'x-amz-copy-source': `/${BUCKET}/src` },
    })
    let response = await client.request({
      method: 'GET', bucket: BUCKET, key: 'copied', query: { tagging: '' },
    })
    assert.deepEqual(allTags(response.text, 'Key'), ['a'])

    await client.request({
      method: 'PUT', bucket: BUCKET, key: 'replaced',
      headers: {
        'x-amz-copy-source': `/${BUCKET}/src`,
        'x-amz-tagging-directive': 'REPLACE',
        'x-amz-tagging': 'b=2',
      },
    })
    response = await client.request({
      method: 'GET', bucket: BUCKET, key: 'replaced', query: { tagging: '' },
    })
    assert.deepEqual(allTags(response.text, 'Key'), ['b'])
  })

  it('round-trips bucket tags', async () => {
    const missing = await client.request({ method: 'GET', bucket: BUCKET, query: { tagging: '' } })
    assert.equal(missing.status, 404)
    assert.equal(tag(missing.text, 'Code'), 'NoSuchTagSet')

    await client.request({
      method: 'PUT', bucket: BUCKET, query: { tagging: '' },
      body: '<Tagging><TagSet><Tag><Key>cost-center</Key><Value>eng</Value></Tag></TagSet></Tagging>',
    })
    const response = await client.request({ method: 'GET', bucket: BUCKET, query: { tagging: '' } })
    assert.deepEqual(allTags(response.text, 'Value'), ['eng'])
  })
})

/* -------------------------------- lifecycle ------------------------------- */

describe('lifecycle', () => {
  const CONFIG =
    '<LifecycleConfiguration>' +
    '<Rule><ID>expire-logs</ID><Status>Enabled</Status>' +
    '<Filter><Prefix>logs/</Prefix></Filter>' +
    '<Expiration><Days>30</Days></Expiration></Rule>' +
    '<Rule><ID>abort-stale</ID><Status>Enabled</Status>' +
    '<Filter><Prefix></Prefix></Filter>' +
    '<AbortIncompleteMultipartUpload><DaysAfterInitiation>7</DaysAfterInitiation>' +
    '</AbortIncompleteMultipartUpload></Rule>' +
    '</LifecycleConfiguration>'

  const setLifecycle = (body = CONFIG) => client.request({
    method: 'PUT', bucket: BUCKET, query: { lifecycle: '' }, body,
  })

  it('round-trips the configuration', async () => {
    assert.equal((await setLifecycle()).status, 200)
    const stored = await client.request({ method: 'GET', bucket: BUCKET, query: { lifecycle: '' } })
    assert.equal(stored.status, 200)
    assert.deepEqual(allTags(stored.text, 'ID'), ['expire-logs', 'abort-stale'])
    assert.equal(tag(stored.text, 'Days'), '30')
  })

  it('rejects a rule with no action', async () => {
    const response = await setLifecycle(
      '<LifecycleConfiguration><Rule><ID>x</ID><Status>Enabled</Status></Rule></LifecycleConfiguration>')
    assert.equal(response.status, 400)
    assert.equal(tag(response.text, 'Code'), 'MalformedXML')
  })

  it('expires only objects matching the rule prefix and age', async () => {
    await setLifecycle()
    await client.request({ method: 'PUT', bucket: BUCKET, key: 'logs/old.txt', body: 'old' })
    await client.request({ method: 'PUT', bucket: BUCKET, key: 'logs/new.txt', body: 'new' })
    await client.request({ method: 'PUT', bucket: BUCKET, key: 'keep/data.txt', body: 'keep' })

    // Age one object past the 30-day threshold.
    harness.server.store.metadata.db
      .prepare('UPDATE objects SET last_modified = ? WHERE bucket = ? AND key = ?')
      .run(Date.now() - 40 * DAY_MS, BUCKET, Buffer.from('logs/old.txt'))

    const summary = await runLifecycle(harness.server.store)
    assert.equal(summary.expiredObjects, 1)

    const listing = await client.request({ method: 'GET', bucket: BUCKET, query: { 'list-type': '2' } })
    assert.deepEqual(allTags(listing.text, 'Key'), ['keep/data.txt', 'logs/new.txt'])
  })

  it('aborts multipart uploads older than the threshold', async () => {
    await setLifecycle()
    const create = await client.request({
      method: 'POST', bucket: BUCKET, key: 'stalled.bin', query: { uploads: '' },
    })
    const uploadId = tag(create.text, 'UploadId')
    await client.request({
      method: 'PUT', bucket: BUCKET, key: 'stalled.bin',
      query: { partNumber: '1', uploadId }, body: 'partial',
    })

    harness.server.store.metadata.db
      .prepare('UPDATE uploads SET initiated_at = ? WHERE upload_id = ?')
      .run(Date.now() - 10 * DAY_MS, uploadId)

    const summary = await runLifecycle(harness.server.store)
    assert.equal(summary.abortedUploads, 1)

    const response = await client.request({
      method: 'GET', bucket: BUCKET, key: 'stalled.bin', query: { uploadId },
    })
    assert.equal(response.status, 404)
  })

  it('expires noncurrent versions', async () => {
    await client.request({
      method: 'PUT', bucket: BUCKET, query: { versioning: '' },
      body: '<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>',
    })
    await setLifecycle(
      '<LifecycleConfiguration><Rule><ID>trim</ID><Status>Enabled</Status>' +
      '<Filter><Prefix></Prefix></Filter>' +
      '<NoncurrentVersionExpiration><NoncurrentDays>7</NoncurrentDays></NoncurrentVersionExpiration>' +
      '</Rule></LifecycleConfiguration>')

    await client.request({ method: 'PUT', bucket: BUCKET, key: 'v.txt', body: 'v1' })
    await client.request({ method: 'PUT', bucket: BUCKET, key: 'v.txt', body: 'v2' })

    harness.server.store.metadata.db
      .prepare('UPDATE objects SET last_modified = ? WHERE bucket = ? AND is_latest = 0')
      .run(Date.now() - 30 * DAY_MS, BUCKET)

    const summary = await runLifecycle(harness.server.store)
    assert.equal(summary.expiredVersions, 1)
    // The current version survives.
    const current = await client.request({ method: 'GET', bucket: BUCKET, key: 'v.txt' })
    assert.equal(current.text, 'v2')
  })

  it('does nothing for disabled rules', async () => {
    await setLifecycle(
      '<LifecycleConfiguration><Rule><ID>off</ID><Status>Disabled</Status>' +
      '<Filter><Prefix></Prefix></Filter><Expiration><Days>0</Days></Expiration>' +
      '</Rule></LifecycleConfiguration>')
    await client.request({ method: 'PUT', bucket: BUCKET, key: 'safe.txt', body: 'x' })
    const summary = await runLifecycle(harness.server.store)
    assert.equal(summary.expiredObjects, 0)
    assert.equal((await client.request({ method: 'GET', bucket: BUCKET, key: 'safe.txt' })).status, 200)
  })
})

/* ------------------------------ notifications ----------------------------- */

describe('event notifications', () => {
  let webhook
  let received
  let endpoint

  before(async () => {
    received = []
    webhook = createHttpServer((req, res) => {
      const chunks = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => {
        try {
          received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch { /* ignore malformed */ }
        res.writeHead(200).end()
      })
    })
    await new Promise((resolve) => webhook.listen(0, '127.0.0.1', resolve))
    endpoint = `http://127.0.0.1:${webhook.address().port}/hook`
  })

  after(async () => {
    await new Promise((resolve) => webhook.close(resolve))
  })

  const configure = (events, filter = '') => client.request({
    method: 'PUT', bucket: BUCKET, query: { notification: '' },
    body: '<NotificationConfiguration><WebhookConfiguration>' +
      '<Id>hook</Id>' + `<Endpoint>${endpoint}</Endpoint>` +
      events.map((event) => `<Event>${event}</Event>`).join('') +
      filter + '</WebhookConfiguration></NotificationConfiguration>',
  })

  it('round-trips the configuration', async () => {
    assert.equal((await configure(['s3:ObjectCreated:*'])).status, 200)
    const stored = await client.request({ method: 'GET', bucket: BUCKET, query: { notification: '' } })
    assert.equal(stored.status, 200)
    assert.equal(tag(stored.text, 'Endpoint'), endpoint)
    assert.deepEqual(allTags(stored.text, 'Event'), ['s3:ObjectCreated:*'])
  })

  it('rejects an unknown event name', async () => {
    const response = await configure(['s3:NotAnEvent'])
    assert.equal(response.status, 400)
    assert.equal(tag(response.text, 'Code'), 'MalformedXML')
  })

  it('delivers an S3-shaped event on upload and delete', async () => {
    received.length = 0
    await configure(['s3:ObjectCreated:*', 's3:ObjectRemoved:*'])

    await client.request({ method: 'PUT', bucket: BUCKET, key: 'watched.txt', body: 'hello' })
    await client.request({ method: 'DELETE', bucket: BUCKET, key: 'watched.txt' })
    await harness.server.notifications.drain()

    assert.equal(received.length, 2)
    const [created, removed] = received
    assert.equal(created.Records[0].eventName, 'ObjectCreated:Put')
    assert.equal(created.Records[0].s3.bucket.name, BUCKET)
    assert.equal(created.Records[0].s3.object.key, 'watched.txt')
    assert.equal(created.Records[0].s3.object.size, 5)
    assert.equal(removed.Records[0].eventName, 'ObjectRemoved:Delete')
  })

  it('honours prefix and suffix filters', async () => {
    received.length = 0
    await configure(['s3:ObjectCreated:*'],
      '<Filter><S3Key>' +
      '<FilterRule><Name>prefix</Name><Value>watch/</Value></FilterRule>' +
      '<FilterRule><Name>suffix</Name><Value>.txt</Value></FilterRule>' +
      '</S3Key></Filter>')

    await client.request({ method: 'PUT', bucket: BUCKET, key: 'watch/a.txt', body: 'yes' })
    await client.request({ method: 'PUT', bucket: BUCKET, key: 'watch/b.bin', body: 'no' })
    await client.request({ method: 'PUT', bucket: BUCKET, key: 'other/c.txt', body: 'no' })
    await harness.server.notifications.drain()

    assert.equal(received.length, 1)
    assert.equal(received[0].Records[0].s3.object.key, 'watch/a.txt')
  })

  it('does not fail the request when the webhook is unreachable', async () => {
    await client.request({
      method: 'PUT', bucket: BUCKET, query: { notification: '' },
      body: '<NotificationConfiguration><WebhookConfiguration><Id>dead</Id>' +
        '<Endpoint>http://127.0.0.1:1/nowhere</Endpoint>' +
        '<Event>s3:ObjectCreated:*</Event></WebhookConfiguration></NotificationConfiguration>',
    })
    const response = await client.request({ method: 'PUT', bucket: BUCKET, key: 'still-ok.txt', body: 'x' })
    assert.equal(response.status, 200)
    await harness.server.notifications.drain()
  })
})
