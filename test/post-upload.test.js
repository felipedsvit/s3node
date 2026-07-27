import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, beforeEach, describe, it } from 'node:test'
import { ALGORITHM, calculateSignature, deriveSigningKey } from '../src/auth/sigv4.js'
import { parseBoundary, parseFormData } from '../src/features/formdata.js'
import { Readable } from 'node:stream'
import { CREDENTIAL, resetBuckets, startServer, tag } from './helpers/harness.js'

const BUCKET = 'post-bucket'
const BOUNDARY = '----s3nodeTestBoundary9f3a'

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

function amzTimestamp(date = new Date()) {
  return `${date.toISOString().replace(/[-:]/g, '').split('.')[0]}Z`
}

/** Builds the same form a browser would submit to an S3 POST endpoint. */
function buildForm({
  key = 'uploads/${filename}',
  body = 'form upload payload',
  filename = 'note.txt',
  fileContentType = 'text/plain',
  extraFields = {},
  extraConditions = [],
  keyPrefix = '',
  expiresInMs = 60_000,
  now = new Date(),
  credential = CREDENTIAL,
  tamperPolicy = false,
} = {}) {
  const amzDate = amzTimestamp(now)
  const dateStamp = amzDate.slice(0, 8)
  const scope = `${dateStamp}/us-east-1/s3/aws4_request`

  const fields = {
    key,
    bucket: BUCKET,
    'x-amz-algorithm': ALGORITHM,
    'x-amz-credential': `${credential.accessKeyId}/${scope}`,
    'x-amz-date': amzDate,
    ...extraFields,
  }

  const policy = {
    expiration: new Date(now.getTime() + expiresInMs).toISOString(),
    conditions: [
      { bucket: BUCKET },
      ['starts-with', '$key', keyPrefix],
      { 'x-amz-algorithm': ALGORITHM },
      { 'x-amz-credential': fields['x-amz-credential'] },
      { 'x-amz-date': amzDate },
      ...extraConditions,
    ],
  }

  const encoded = Buffer.from(JSON.stringify(policy), 'utf8').toString('base64')
  const signature = calculateSignature(
    deriveSigningKey(credential.secretAccessKey, dateStamp, 'us-east-1', 's3', credential.accessKeyId),
    encoded,
  )

  fields.policy = tamperPolicy
    ? Buffer.from(JSON.stringify({ ...policy, conditions: [{ bucket: 'other' }] })).toString('base64')
    : encoded
  fields['x-amz-signature'] = signature

  const parts = []
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`))
  }
  parts.push(Buffer.from(
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: ${fileContentType}\r\n\r\n`))
  parts.push(Buffer.isBuffer(body) ? body : Buffer.from(body))
  parts.push(Buffer.from(`\r\n--${BOUNDARY}--\r\n`))

  return Buffer.concat(parts)
}

function post(body, headers = {}) {
  return client.send({
    method: 'POST',
    path: `/${BUCKET}`,
    headers: {
      'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
      'content-length': String(body.length),
      ...headers,
    },
    body,
  })
}

describe('multipart/form-data parser', () => {
  const collect = async (stream) => {
    const chunks = []
    for await (const chunk of stream) chunks.push(chunk)
    return Buffer.concat(chunks)
  }

  it('extracts fields and hands the file back as a stream', async () => {
    const form = buildForm({ body: 'streamed content' })
    const { fields, file } = await parseFormData([Readable.from([form])], { boundary: BOUNDARY })
    assert.equal(fields.get('bucket'), BUCKET)
    assert.equal(fields.get('x-amz-algorithm'), ALGORITHM)
    assert.equal(file.filename, 'note.txt')
    assert.equal(file.contentType, 'text/plain')
    assert.equal((await collect(file.stream)).toString(), 'streamed content')
  })

  it('reassembles a file split across many chunks', async () => {
    const payload = randomBytes(200_000)
    const form = buildForm({ body: payload, filename: 'big.bin' })
    // Feed in small slices so the closing boundary straddles chunk boundaries.
    const slices = []
    for (let offset = 0; offset < form.length; offset += 997) {
      slices.push(form.subarray(offset, offset + 997))
    }
    const { file } = await parseFormData([Readable.from(slices)], { boundary: BOUNDARY })
    assert.deepEqual(await collect(file.stream), payload)
  })

  it('handles a body that happens to contain the boundary text', async () => {
    const payload = Buffer.from(`prefix --${BOUNDARY} not a real boundary suffix`)
    const form = buildForm({ body: payload })
    const { file } = await parseFormData([Readable.from([form])], { boundary: BOUNDARY })
    // The delimiter is only a delimiter when preceded by CRLF.
    assert.deepEqual(await collect(file.stream), payload)
  })

  it('reads the boundary out of the Content-Type', () => {
    assert.equal(parseBoundary('multipart/form-data; boundary=abc123'), 'abc123')
    assert.equal(parseBoundary('multipart/form-data; boundary="quoted one"'), 'quoted one')
    assert.throws(() => parseBoundary('multipart/form-data'), (err) => err.code === 'MalformedPOSTRequest')
  })
})

describe('POST object upload', () => {
  it('stores the object and substitutes ${filename} in the key', async () => {
    const response = await post(buildForm({ body: 'hello from a form' }))
    assert.equal(response.status, 204)
    assert.ok(response.headers.etag)

    const stored = await client.request({ method: 'GET', bucket: BUCKET, key: 'uploads/note.txt' })
    assert.equal(stored.status, 200)
    assert.equal(stored.text, 'hello from a form')
  })

  it('honours success_action_status 201 with an XML body', async () => {
    const response = await post(buildForm({
      extraFields: { success_action_status: '201' },
      extraConditions: [{ success_action_status: '201' }],
    }))
    assert.equal(response.status, 201)
    assert.equal(tag(response.text, 'Bucket'), BUCKET)
    assert.equal(tag(response.text, 'Key'), 'uploads/note.txt')
  })

  it('redirects when success_action_redirect is set', async () => {
    const response = await post(buildForm({
      extraFields: { success_action_redirect: 'https://example.com/done' },
      extraConditions: [{ success_action_redirect: 'https://example.com/done' }],
    }))
    assert.equal(response.status, 303)
    const location = new URL(response.headers.location)
    assert.equal(location.origin + location.pathname, 'https://example.com/done')
    assert.equal(location.searchParams.get('key'), 'uploads/note.txt')
  })

  it('stores Content-Type and user metadata from form fields', async () => {
    await post(buildForm({
      extraFields: { 'content-type': 'text/markdown', 'x-amz-meta-author': 'ada' },
      extraConditions: [{ 'content-type': 'text/markdown' }, { 'x-amz-meta-author': 'ada' }],
    }))
    const head = await client.request({ method: 'HEAD', bucket: BUCKET, key: 'uploads/note.txt' })
    assert.equal(head.headers['content-type'], 'text/markdown')
    assert.equal(head.headers['x-amz-meta-author'], 'ada')
  })

  it('accepts a large body without buffering it', async () => {
    const payload = randomBytes(3 * 1024 * 1024)
    const response = await post(buildForm({ body: payload, filename: 'big.bin' }))
    assert.equal(response.status, 204)
    const stored = await client.request({ method: 'GET', bucket: BUCKET, key: 'uploads/big.bin' })
    assert.deepEqual(stored.body, payload)
  })

  /* ------------------------------ rejections ----------------------------- */

  it('rejects a tampered policy', async () => {
    const response = await post(buildForm({ tamperPolicy: true }))
    assert.equal(response.status, 403)
    assert.equal(tag(response.text, 'Code'), 'SignatureDoesNotMatch')
  })

  it('rejects an expired policy', async () => {
    const response = await post(buildForm({ expiresInMs: -1000 }))
    assert.equal(response.status, 403)
    assert.match(response.text, /expired/i)
  })

  it('rejects a key outside a starts-with condition', async () => {
    const response = await post(buildFormWithKeyPrefix())
    assert.equal(response.status, 403)
    assert.match(response.text, /must start with/i)
  })

  it('rejects a field that no condition covers', async () => {
    // `acl` is submitted but never mentioned in the policy.
    const response = await post(buildForm({ extraFields: { acl: 'public-read' } }))
    assert.equal(response.status, 403)
    assert.match(response.text, /not covered by the policy/i)
  })

  it('rejects a policy signed for another bucket', async () => {
    const response = await post(buildForm({ extraFields: { bucket: 'someone-else' } }))
    assert.equal(response.status, 403)
  })

  it('rejects an unknown access key', async () => {
    const response = await post(buildForm({
      credential: { accessKeyId: 'AKIDGHOST', secretAccessKey: 'nope' },
    }))
    assert.equal(response.status, 403)
    assert.equal(tag(response.text, 'Code'), 'InvalidAccessKeyId')
  })

  it('rejects a body outside content-length-range', async () => {
    const response = await post(buildForm({
      body: randomBytes(5000),
      extraConditions: [['content-length-range', 0, 100]],
    }))
    assert.equal(response.status, 400)
    assert.equal(tag(response.text, 'Code'), 'EntityTooLarge')
    // The oversized object must not survive the rejection.
    const stored = await client.request({ method: 'GET', bucket: BUCKET, key: 'uploads/note.txt' })
    assert.equal(stored.status, 404)
  })

  it('rejects a non-multipart POST', async () => {
    const response = await client.send({
      method: 'POST', path: `/${BUCKET}`,
      headers: { 'content-type': 'application/json', 'content-length': '2' },
      body: Buffer.from('{}'),
    })
    assert.equal(response.status, 400)
    assert.equal(tag(response.text, 'Code'), 'MalformedPOSTRequest')
  })

  it('respects a bucket policy Deny on the resolved key', async () => {
    await client.request({
      method: 'PUT', bucket: BUCKET, query: { policy: '' },
      body: JSON.stringify({
        Statement: [{
          Effect: 'Deny', Principal: '*', Action: 's3:PutObject',
          Resource: `arn:aws:s3:::${BUCKET}/uploads/*`,
        }],
      }),
    })
    const response = await post(buildForm())
    assert.equal(response.status, 403)
    assert.equal(tag(response.text, 'Code'), 'AccessDenied')
  })
})

/** A form whose policy pins the key prefix, used by the starts-with rejection. */
function buildFormWithKeyPrefix() {
  return buildForm({ key: 'elsewhere/note.txt', extraConditions: [], keyPrefix: 'uploads/' })
}
