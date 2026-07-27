import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, beforeEach, describe, it } from 'node:test'
import { EncryptionManager, advanceIv, partIv } from '../src/features/encryption.js'
import { allTags, startServer, tag } from './helpers/harness.js'

const BUCKET = 'encrypted-bucket'

const customerKey = randomBytes(32)
const CUSTOMER_HEADERS = {
  'x-amz-server-side-encryption-customer-algorithm': 'AES256',
  'x-amz-server-side-encryption-customer-key': customerKey.toString('base64'),
  'x-amz-server-side-encryption-customer-key-md5': createHash('md5').update(customerKey).digest('base64'),
}

let harness
let client

before(async () => {
  harness = await startServer()
  client = harness.client
})

after(async () => { await harness.cleanup() })

beforeEach(async () => {
  const listing = await client.request({ method: 'GET' })
  for (const name of allTags(listing.text, 'Name')) {
    const page = await client.request({ method: 'GET', bucket: name, query: { 'list-type': '2' } })
    for (const key of allTags(page.text, 'Key')) {
      await client.request({ method: 'DELETE', bucket: name, key })
    }
    await client.request({ method: 'DELETE', bucket: name })
  }
  await client.request({ method: 'PUT', bucket: BUCKET })
})

/** Every blob byte currently on disk, for proving the ciphertext is not plaintext. */
async function readAllBlobs(root) {
  const dataDir = join(root, 'data', 'data')
  const found = []
  for (const first of await readdir(dataDir)) {
    for (const second of await readdir(join(dataDir, first))) {
      for (const name of await readdir(join(dataDir, first, second))) {
        found.push(await readFile(join(dataDir, first, second, name)))
      }
    }
  }
  return found
}

describe('counter arithmetic', () => {
  it('adds to a 128-bit big-endian counter', () => {
    const zero = Buffer.alloc(16)
    assert.equal(advanceIv(zero, 1).toString('hex'), '0'.repeat(31) + '1')
    assert.equal(advanceIv(zero, 256).toString('hex'), '0'.repeat(29) + '100')
  })

  it('carries across byte boundaries', () => {
    const iv = Buffer.from('000000000000000000000000000000ff', 'hex')
    assert.equal(advanceIv(iv, 1).toString('hex'), '00000000000000000000000000000100')
  })

  it('wraps rather than overflowing', () => {
    const iv = Buffer.from('f'.repeat(32), 'hex')
    assert.equal(advanceIv(iv, 1).toString('hex'), '0'.repeat(32))
  })

  it('spaces part counter windows far enough apart to never overlap', () => {
    const base = Buffer.alloc(16)
    const first = BigInt(`0x${partIv(base, 1).toString('hex')}`)
    const second = BigInt(`0x${partIv(base, 2).toString('hex')}`)
    // A part maxes out at 5 GiB, which is well under 2^64 blocks of headroom.
    assert.equal(second - first, 1n << 64n)
    assert.ok(first > BigInt(5 * 1024 ** 3) / 16n)
  })
})

describe('SSE-S3', () => {
  it('round-trips and reports the algorithm', async () => {
    const payload = randomBytes(5000)
    const put = await client.request({
      method: 'PUT', bucket: BUCKET, key: 'managed.bin', body: payload,
      headers: { 'x-amz-server-side-encryption': 'AES256' },
    })
    assert.equal(put.status, 200)
    assert.equal(put.headers['x-amz-server-side-encryption'], 'AES256')
    // The ETag stays the plaintext MD5, as clients expect.
    assert.equal(put.headers.etag, `"${createHash('md5').update(payload).digest('hex')}"`)

    const get = await client.request({ method: 'GET', bucket: BUCKET, key: 'managed.bin' })
    assert.deepEqual(get.body, payload)
    assert.equal(get.headers['x-amz-server-side-encryption'], 'AES256')
  })

  it('does not leave plaintext on disk', async () => {
    const payload = Buffer.from('SUPER SECRET MARKER STRING'.repeat(40))
    await client.request({
      method: 'PUT', bucket: BUCKET, key: 'secret.bin', body: payload,
      headers: { 'x-amz-server-side-encryption': 'AES256' },
    })
    const blobs = await readAllBlobs(harness.root)
    assert.ok(blobs.length > 0, 'expected at least one blob on disk')
    for (const blob of blobs) {
      assert.equal(blob.includes(Buffer.from('SUPER SECRET MARKER')), false,
        'plaintext was written to disk')
    }
  })

  it('serves ranges from an encrypted object', async () => {
    const payload = randomBytes(4096)
    await client.request({
      method: 'PUT', bucket: BUCKET, key: 'ranged.bin', body: payload,
      headers: { 'x-amz-server-side-encryption': 'AES256' },
    })
    // Offsets deliberately off a 16-byte block boundary to exercise the CTR seek.
    for (const [start, end] of [[0, 15], [1, 5], [17, 100], [4000, 4095], [4095, 4095]]) {
      const response = await client.request({
        method: 'GET', bucket: BUCKET, key: 'ranged.bin', headers: { range: `bytes=${start}-${end}` },
      })
      assert.equal(response.status, 206, `range ${start}-${end}`)
      assert.deepEqual(response.body, payload.subarray(start, end + 1), `range ${start}-${end}`)
    }
  })

  it('encrypts a multipart upload and reads across part boundaries', async () => {
    const parts = [randomBytes(64), randomBytes(64), randomBytes(20)]
    const create = await client.request({
      method: 'POST', bucket: BUCKET, key: 'multi.bin', query: { uploads: '' },
      headers: { 'x-amz-server-side-encryption': 'AES256' },
    })
    assert.equal(create.headers['x-amz-server-side-encryption'], 'AES256')
    const uploadId = tag(create.text, 'UploadId')

    const etags = []
    for (const [index, part] of parts.entries()) {
      const response = await client.request({
        method: 'PUT', bucket: BUCKET, key: 'multi.bin',
        query: { partNumber: String(index + 1), uploadId }, body: part,
      })
      assert.equal(response.status, 200)
      etags.push(response.headers.etag)
    }
    await client.request({
      method: 'POST', bucket: BUCKET, key: 'multi.bin', query: { uploadId },
      body: '<CompleteMultipartUpload>' + etags.map((etag, index) =>
        `<Part><PartNumber>${index + 1}</PartNumber><ETag>${etag}</ETag></Part>`).join('') +
        '</CompleteMultipartUpload>',
    })

    const whole = Buffer.concat(parts)
    const get = await client.request({ method: 'GET', bucket: BUCKET, key: 'multi.bin' })
    assert.deepEqual(get.body, whole)

    const straddle = await client.request({
      method: 'GET', bucket: BUCKET, key: 'multi.bin', headers: { range: 'bytes=60-70' },
    })
    assert.deepEqual(straddle.body, whole.subarray(60, 71))
  })

  it('copies an encrypted object', async () => {
    const payload = randomBytes(1000)
    await client.request({
      method: 'PUT', bucket: BUCKET, key: 'src.bin', body: payload,
      headers: { 'x-amz-server-side-encryption': 'AES256' },
    })
    const copy = await client.request({
      method: 'PUT', bucket: BUCKET, key: 'dst.bin',
      headers: {
        'x-amz-copy-source': `/${BUCKET}/src.bin`,
        'x-amz-server-side-encryption': 'AES256',
      },
    })
    assert.equal(copy.status, 200)
    const get = await client.request({ method: 'GET', bucket: BUCKET, key: 'dst.bin' })
    assert.deepEqual(get.body, payload)
  })

  it('rejects an unsupported algorithm', async () => {
    const response = await client.request({
      method: 'PUT', bucket: BUCKET, key: 'bad.bin', body: 'x',
      headers: { 'x-amz-server-side-encryption': 'aws:kms' },
    })
    assert.equal(response.status, 400)
  })
})

describe('SSE-C', () => {
  it('round-trips when the same key is presented', async () => {
    const payload = randomBytes(3000)
    const put = await client.request({
      method: 'PUT', bucket: BUCKET, key: 'customer.bin', body: payload, headers: CUSTOMER_HEADERS,
    })
    assert.equal(put.status, 200)
    assert.equal(put.headers['x-amz-server-side-encryption-customer-algorithm'], 'AES256')
    assert.equal(put.headers['x-amz-server-side-encryption-customer-key-md5'],
      CUSTOMER_HEADERS['x-amz-server-side-encryption-customer-key-md5'])

    const get = await client.request({
      method: 'GET', bucket: BUCKET, key: 'customer.bin', headers: CUSTOMER_HEADERS,
    })
    assert.deepEqual(get.body, payload)
  })

  it('refuses to read without the key', async () => {
    await client.request({
      method: 'PUT', bucket: BUCKET, key: 'customer.bin', body: 'secret', headers: CUSTOMER_HEADERS,
    })
    const response = await client.request({ method: 'GET', bucket: BUCKET, key: 'customer.bin' })
    assert.equal(response.status, 400)
    assert.equal(tag(response.text, 'Code'), 'InvalidRequest')
  })

  it('refuses to read with the wrong key', async () => {
    await client.request({
      method: 'PUT', bucket: BUCKET, key: 'customer.bin', body: 'secret', headers: CUSTOMER_HEADERS,
    })
    const wrongKey = randomBytes(32)
    const response = await client.request({
      method: 'GET', bucket: BUCKET, key: 'customer.bin',
      headers: {
        'x-amz-server-side-encryption-customer-algorithm': 'AES256',
        'x-amz-server-side-encryption-customer-key': wrongKey.toString('base64'),
        'x-amz-server-side-encryption-customer-key-md5':
          createHash('md5').update(wrongKey).digest('base64'),
      },
    })
    assert.equal(response.status, 403)
  })

  it('rejects a key whose MD5 does not match', async () => {
    const response = await client.request({
      method: 'PUT', bucket: BUCKET, key: 'bad.bin', body: 'x',
      headers: { ...CUSTOMER_HEADERS, 'x-amz-server-side-encryption-customer-key-md5': 'AAAA' },
    })
    assert.equal(response.status, 400)
    assert.equal(tag(response.text, 'Code'), 'InvalidDigest')
  })

  it('rejects a key of the wrong length', async () => {
    const short = randomBytes(16)
    const response = await client.request({
      method: 'PUT', bucket: BUCKET, key: 'bad.bin', body: 'x',
      headers: {
        'x-amz-server-side-encryption-customer-algorithm': 'AES256',
        'x-amz-server-side-encryption-customer-key': short.toString('base64'),
        'x-amz-server-side-encryption-customer-key-md5': createHash('md5').update(short).digest('base64'),
      },
    })
    assert.equal(response.status, 400)
  })

  it('never stores the customer key', async () => {
    await client.request({
      method: 'PUT', bucket: BUCKET, key: 'customer.bin', body: 'x', headers: CUSTOMER_HEADERS,
    })
    const database = await readFile(join(harness.root, 'data', 'metadata.sqlite'))
    assert.equal(database.includes(customerKey), false, 'the customer key reached the database')
    assert.equal(database.includes(Buffer.from(customerKey.toString('base64'))), false)
  })

  it('serves ranges from an SSE-C object', async () => {
    const payload = randomBytes(2048)
    await client.request({
      method: 'PUT', bucket: BUCKET, key: 'ranged.bin', body: payload, headers: CUSTOMER_HEADERS,
    })
    const response = await client.request({
      method: 'GET', bucket: BUCKET, key: 'ranged.bin',
      headers: { ...CUSTOMER_HEADERS, range: 'bytes=33-99' },
    })
    assert.equal(response.status, 206)
    assert.deepEqual(response.body, payload.subarray(33, 100))
  })
})

describe('EncryptionManager', () => {
  it('unwraps an SSE-S3 data key it wrapped', () => {
    const manager = new EncryptionManager(randomBytes(32))
    const { key, context } = manager.create({ mode: 'SSE-S3' })
    assert.deepEqual(manager.resolveKey(context, null), key)
  })

  it('cannot unwrap a data key with a different master key', () => {
    const manager = new EncryptionManager(randomBytes(32))
    const { context } = manager.create({ mode: 'SSE-S3' })
    const stranger = new EncryptionManager(randomBytes(32))
    assert.throws(() => stranger.resolveKey(context, null))
  })
})
