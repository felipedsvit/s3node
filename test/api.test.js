import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, describe, it } from 'node:test'
import { createServer } from '../dist/src/index.js'
import { Crc32 } from '../dist/src/util/crc.js'
import { TestClient } from './helpers/client.js'

const CREDENTIAL = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' }
const BUCKET = 'test-bucket'

let root
let server
let client

function unescape(value) {
  return value
    .replaceAll('&lt;', '<').replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"').replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')
}

function tag(xml, name) {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml)
  return match ? unescape(match[1]) : undefined
}

function allTags(xml, name) {
  return [...xml.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'g'))].map((m) => unescape(m[1]))
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), 's3node-api-'))
  server = await createServer({
    dataDir: join(root, 'data'),
    credentials: [CREDENTIAL],
    minPartSize: 16,
  })
  client = new TestClient({ endpoint: server.endpoint, ...CREDENTIAL })
})

after(async () => {
  await server.close()
  await rm(root, { recursive: true, force: true })
})

beforeEach(async () => {
  // Reset to a single empty bucket between tests.
  const listing = await client.request({ method: 'GET' })
  for (const name of allTags(listing.text, 'Name')) {
    let token
    do {
      const page = await client.request({
        method: 'GET', bucket: name,
        query: token ? { 'list-type': '2', 'continuation-token': token } : { 'list-type': '2' },
      })
      for (const key of allTags(page.text, 'Key')) {
        await client.request({ method: 'DELETE', bucket: name, key })
      }
      token = tag(page.text, 'NextContinuationToken')
    } while (token)
    const uploads = await client.request({ method: 'GET', bucket: name, query: { uploads: '' } })
    for (const uploadId of allTags(uploads.text, 'UploadId')) {
      const key = allTags(uploads.text, 'Key')[allTags(uploads.text, 'UploadId').indexOf(uploadId)]
      await client.request({ method: 'DELETE', bucket: name, key, query: { uploadId } })
    }
    await client.request({ method: 'DELETE', bucket: name })
  }
  const created = await client.request({ method: 'PUT', bucket: BUCKET })
  assert.ok([200, 409].includes(created.status), `bucket setup returned ${created.status}`)
})

describe('authentication', () => {
  it('accepts a correctly signed request', async () => {
    assert.equal((await client.request({ method: 'GET' })).status, 200)
  })

  it('rejects a tampered signature', async () => {
    const response = await client.request({ method: 'GET', overrideSignature: 'f'.repeat(64) })
    assert.equal(response.status, 403)
    assert.equal(tag(response.text, 'Code'), 'SignatureDoesNotMatch')
  })

  it('rejects an unknown access key', async () => {
    const stranger = new TestClient({
      endpoint: server.endpoint, accessKeyId: 'AKIDNOPE', secretAccessKey: 'nope',
    })
    const response = await stranger.request({ method: 'GET' })
    assert.equal(response.status, 403)
    assert.equal(tag(response.text, 'Code'), 'InvalidAccessKeyId')
  })

  it('rejects an unsigned request', async () => {
    const response = await client.send({ method: 'GET', path: '/', headers: {} })
    assert.equal(response.status, 403)
    assert.equal(tag(response.text, 'Code'), 'AccessDenied')
  })

  it('rejects a request outside the 15 minute skew window', async () => {
    const response = await client.request({
      method: 'GET', now: new Date(Date.now() - 20 * 60 * 1000),
    })
    assert.equal(response.status, 403)
    assert.equal(tag(response.text, 'Code'), 'RequestTimeTooSkewed')
  })

  it('accepts a presigned URL and rejects an expired one', async () => {
    await client.request({ method: 'PUT', bucket: BUCKET, key: 'signed.txt', body: 'presigned' })

    const fresh = client.presign({ method: 'GET', bucket: BUCKET, key: 'signed.txt' })
    const ok = await client.send({ method: 'GET', path: fresh.path, headers: {} })
    assert.equal(ok.status, 200)
    assert.equal(ok.text, 'presigned')

    const stale = client.presign({
      method: 'GET', bucket: BUCKET, key: 'signed.txt',
      expiresIn: 60, now: new Date(Date.now() - 120_000),
    })
    const expired = await client.send({ method: 'GET', path: stale.path, headers: {} })
    assert.equal(expired.status, 403)
  })

  it('refuses 100-continue before the body when the signature is wrong', async () => {
    const response = await client.request({
      method: 'PUT', bucket: BUCKET, key: 'big.bin',
      body: randomBytes(1024),
      headers: { expect: '100-continue' },
      overrideSignature: 'f'.repeat(64),
      waitForContinue: false,
    })
    assert.equal(response.status, 403)
    assert.equal(response.continueReceived, false, 'server must not invite the body')
  })

  it('sends 100-continue once the signature checks out', async () => {
    const response = await client.request({
      method: 'PUT', bucket: BUCKET, key: 'continue.txt',
      body: 'body after continue',
      headers: { expect: '100-continue' },
      waitForContinue: true,
    })
    assert.equal(response.status, 200)
    assert.equal(response.continueReceived, true)
  })
})

describe('buckets', () => {
  it('lists buckets', async () => {
    const response = await client.request({ method: 'GET' })
    assert.equal(response.status, 200)
    assert.match(response.headers['content-type'], /xml/)
    assert.ok(allTags(response.text, 'Name').includes(BUCKET))
  })

  it('heads a bucket and reports 404 for a missing one', async () => {
    assert.equal((await client.request({ method: 'HEAD', bucket: BUCKET })).status, 200)
    assert.equal((await client.request({ method: 'HEAD', bucket: 'absent-bucket' })).status, 404)
  })

  it('returns the location constraint', async () => {
    const response = await client.request({ method: 'GET', bucket: BUCKET, query: { location: '' } })
    assert.equal(response.status, 200)
    assert.match(response.text, /LocationConstraint/)
  })

  it('refuses to delete a bucket that still holds objects', async () => {
    await client.request({ method: 'PUT', bucket: BUCKET, key: 'x', body: 'x' })
    const response = await client.request({ method: 'DELETE', bucket: BUCKET })
    assert.equal(response.status, 409)
    assert.equal(tag(response.text, 'Code'), 'BucketNotEmpty')
  })

  it('rejects an invalid bucket name', async () => {
    const response = await client.request({ method: 'PUT', bucket: 'A' })
    assert.equal(response.status, 400)
    assert.equal(tag(response.text, 'Code'), 'InvalidBucketName')
  })

  it('sets every response header clients expect', async () => {
    const response = await client.request({ method: 'GET' })
    assert.ok(response.headers['x-amz-request-id'])
    assert.ok(response.headers['x-amz-id-2'])
    assert.ok(response.headers.date)
  })
})

describe('objects', () => {
  it('round-trips a signed-payload upload', async () => {
    const payload = randomBytes(2048)
    const put = await client.request({ method: 'PUT', bucket: BUCKET, key: 'obj.bin', body: payload })
    assert.equal(put.status, 200)
    assert.equal(put.headers.etag, `"${createHash('md5').update(payload).digest('hex')}"`)

    const get = await client.request({ method: 'GET', bucket: BUCKET, key: 'obj.bin' })
    assert.equal(get.status, 200)
    assert.deepEqual(get.body, payload)
    assert.equal(Number(get.headers['content-length']), payload.length)
  })

  it('round-trips an UNSIGNED-PAYLOAD upload', async () => {
    const payload = randomBytes(1024)
    await client.request({
      method: 'PUT', bucket: BUCKET, key: 'unsigned.bin', body: payload, payloadMode: 'unsigned',
    })
    const get = await client.request({ method: 'GET', bucket: BUCKET, key: 'unsigned.bin' })
    assert.deepEqual(get.body, payload)
  })

  /* The aws-cli default. Without decoding, the framing lands in the object. */
  it('round-trips an aws-chunked signed upload without storing the framing', async () => {
    const payload = randomBytes(200_000)
    const put = await client.request({
      method: 'PUT', bucket: BUCKET, key: 'chunked.bin', body: payload,
      payloadMode: 'chunked', chunkSize: 65536,
    })
    assert.equal(put.status, 200)
    assert.equal(put.headers.etag, `"${createHash('md5').update(payload).digest('hex')}"`)

    const get = await client.request({ method: 'GET', bucket: BUCKET, key: 'chunked.bin' })
    assert.deepEqual(get.body, payload)
    assert.equal(get.body.includes(Buffer.from('chunk-signature')), false)
  })

  /* SDK v3 >= 3.729.0 sends this shape by default. */
  it('accepts an aws-chunked body with a CRC32 trailer', async () => {
    const payload = randomBytes(4096)
    const checksum = new Crc32().update(payload).digest('base64')
    const put = await client.request({
      method: 'PUT', bucket: BUCKET, key: 'trailer.bin', body: payload,
      payloadMode: 'chunked-trailer',
      headers: { 'x-amz-trailer': 'x-amz-checksum-crc32', 'x-amz-sdk-checksum-algorithm': 'CRC32' },
      trailers: { 'x-amz-checksum-crc32': checksum },
    })
    assert.equal(put.status, 200)
    assert.equal(put.headers['x-amz-checksum-crc32'], checksum)

    const get = await client.request({ method: 'GET', bucket: BUCKET, key: 'trailer.bin' })
    assert.deepEqual(get.body, payload)
  })

  it('rejects a CRC32 trailer that does not match the body', async () => {
    const response = await client.request({
      method: 'PUT', bucket: BUCKET, key: 'badtrailer.bin', body: randomBytes(512),
      payloadMode: 'chunked-trailer',
      headers: { 'x-amz-trailer': 'x-amz-checksum-crc32' },
      trailers: { 'x-amz-checksum-crc32': 'AAAAAA==' },
    })
    assert.equal(response.status, 400)
    assert.equal((await client.request({ method: 'HEAD', bucket: BUCKET, key: 'badtrailer.bin' })).status, 404)
  })

  it('accepts a matching x-amz-checksum header', async () => {
    const payload = Buffer.from('123456789')
    const response = await client.request({
      method: 'PUT', bucket: BUCKET, key: 'crc.txt', body: payload,
      headers: { 'x-amz-checksum-crc32': new Crc32().update(payload).digest('base64') },
    })
    assert.equal(response.status, 200)
  })

  it('rejects a bad Content-MD5', async () => {
    const response = await client.request({
      method: 'PUT', bucket: BUCKET, key: 'md5.txt', body: 'hello',
      headers: { 'content-md5': 'AAAAAAAAAAAAAAAAAAAAAA==' },
    })
    assert.equal(response.status, 400)
    assert.equal(tag(response.text, 'Code'), 'BadDigest')
  })

  it('stores content type and user metadata', async () => {
    await client.request({
      method: 'PUT', bucket: BUCKET, key: 'meta.txt', body: 'hi',
      headers: { 'content-type': 'text/plain; charset=utf-8', 'x-amz-meta-author': 'ada' },
    })
    const head = await client.request({ method: 'HEAD', bucket: BUCKET, key: 'meta.txt' })
    assert.equal(head.status, 200)
    assert.equal(head.headers['content-type'], 'text/plain; charset=utf-8')
    assert.equal(head.headers['x-amz-meta-author'], 'ada')
    assert.equal(Number(head.headers['content-length']), 2)
    assert.equal(head.body.length, 0, 'HEAD must not carry a body')
  })

  it('serves ranges', async () => {
    await client.request({ method: 'PUT', bucket: BUCKET, key: 'range.txt', body: '0123456789' })
    const partial = await client.request({
      method: 'GET', bucket: BUCKET, key: 'range.txt', headers: { range: 'bytes=2-5' },
    })
    assert.equal(partial.status, 206)
    assert.equal(partial.text, '2345')
    assert.equal(partial.headers['content-range'], 'bytes 2-5/10')

    const suffix = await client.request({
      method: 'GET', bucket: BUCKET, key: 'range.txt', headers: { range: 'bytes=-3' },
    })
    assert.equal(suffix.text, '789')
  })

  it('omits the whole-object checksum from a partial response', async () => {
    const payload = Buffer.from('0123456789')
    await client.request({
      method: 'PUT', bucket: BUCKET, key: 'ck.txt', body: payload,
      headers: { 'x-amz-checksum-crc32': new Crc32().update(payload).digest('base64') },
    })
    const full = await client.request({ method: 'GET', bucket: BUCKET, key: 'ck.txt' })
    assert.ok(full.headers['x-amz-checksum-crc32'], 'a full read should carry the checksum')

    const partial = await client.request({
      method: 'GET', bucket: BUCKET, key: 'ck.txt', headers: { range: 'bytes=0-4' },
    })
    assert.equal(partial.status, 206)
    // The stored checksum describes the whole object; sending it with a slice
    // makes SDK-side validation fail.
    assert.equal(partial.headers['x-amz-checksum-crc32'], undefined)
  })

  it('rejects an unsatisfiable range', async () => {
    await client.request({ method: 'PUT', bucket: BUCKET, key: 'range.txt', body: '0123456789' })
    const response = await client.request({
      method: 'GET', bucket: BUCKET, key: 'range.txt', headers: { range: 'bytes=50-60' },
    })
    assert.equal(response.status, 416)
    assert.equal(response.headers['content-range'], 'bytes */10')
  })

  it('honours conditional headers', async () => {
    const put = await client.request({ method: 'PUT', bucket: BUCKET, key: 'cond.txt', body: 'data' })
    const etag = put.headers.etag

    const notModified = await client.request({
      method: 'GET', bucket: BUCKET, key: 'cond.txt', headers: { 'if-none-match': etag },
    })
    assert.equal(notModified.status, 304)
    assert.equal(notModified.body.length, 0)

    const matched = await client.request({
      method: 'GET', bucket: BUCKET, key: 'cond.txt', headers: { 'if-match': etag },
    })
    assert.equal(matched.status, 200)

    const failed = await client.request({
      method: 'GET', bucket: BUCKET, key: 'cond.txt', headers: { 'if-match': '"nope"' },
    })
    assert.equal(failed.status, 412)
  })

  it('reports 404 for a missing key', async () => {
    const response = await client.request({ method: 'GET', bucket: BUCKET, key: 'ghost' })
    assert.equal(response.status, 404)
    assert.equal(tag(response.text, 'Code'), 'NoSuchKey')
  })

  it('deletes idempotently', async () => {
    await client.request({ method: 'PUT', bucket: BUCKET, key: 'gone.txt', body: 'x' })
    assert.equal((await client.request({ method: 'DELETE', bucket: BUCKET, key: 'gone.txt' })).status, 204)
    assert.equal((await client.request({ method: 'DELETE', bucket: BUCKET, key: 'gone.txt' })).status, 204)
  })

  it('handles keys with spaces, accents, slashes and plus signs', async () => {
    const keys = ['a b/c.txt', 'ação/relatório.txt', 'a+b=c', "quote'and(paren)", 'emoji/\u{1F600}.txt']
    for (const key of keys) {
      const put = await client.request({ method: 'PUT', bucket: BUCKET, key, body: key })
      assert.equal(put.status, 200, `PUT failed for ${key}`)
      const get = await client.request({ method: 'GET', bucket: BUCKET, key })
      assert.equal(get.text, key, `GET mismatch for ${key}`)
    }
    const listing = await client.request({ method: 'GET', bucket: BUCKET, query: { 'list-type': '2' } })
    const listed = allTags(listing.text, 'Key')
    for (const key of keys) assert.ok(listed.includes(key), `${key} missing from listing`)
  })

  it('stores a key containing ../ without touching the filesystem layout', async () => {
    const key = '../../etc/passwd'
    assert.equal((await client.request({ method: 'PUT', bucket: BUCKET, key, body: 'safe' })).status, 200)
    assert.equal((await client.request({ method: 'GET', bucket: BUCKET, key })).text, 'safe')
  })

  it('stores and serves an empty object', async () => {
    await client.request({ method: 'PUT', bucket: BUCKET, key: 'empty.txt', body: '' })
    const get = await client.request({ method: 'GET', bucket: BUCKET, key: 'empty.txt' })
    assert.equal(get.status, 200)
    assert.equal(get.body.length, 0)
    assert.equal(get.headers.etag, '"d41d8cd98f00b204e9800998ecf8427e"')
  })

  it('copies an object', async () => {
    await client.request({
      method: 'PUT', bucket: BUCKET, key: 'src.txt', body: 'copied',
      headers: { 'content-type': 'text/plain' },
    })
    const copy = await client.request({
      method: 'PUT', bucket: BUCKET, key: 'dst.txt',
      headers: { 'x-amz-copy-source': `/${BUCKET}/src.txt` },
    })
    assert.equal(copy.status, 200)
    assert.match(copy.text, /<CopyObjectResult/)
    const get = await client.request({ method: 'GET', bucket: BUCKET, key: 'dst.txt' })
    assert.equal(get.text, 'copied')
    assert.equal(get.headers['content-type'], 'text/plain')
  })
})

describe('listing over HTTP', () => {
  const keys = ['a.txt', 'dir/1.txt', 'dir/2.txt', 'dir/sub/3.txt', 'other/4.txt', 'z.txt']

  beforeEach(async () => {
    for (const key of keys) {
      await client.request({ method: 'PUT', bucket: BUCKET, key, body: key })
    }
  })

  it('lists with ListObjectsV2', async () => {
    const response = await client.request({ method: 'GET', bucket: BUCKET, query: { 'list-type': '2' } })
    assert.equal(response.status, 200)
    assert.deepEqual(allTags(response.text, 'Key'), keys)
    assert.equal(tag(response.text, 'KeyCount'), '6')
    assert.equal(tag(response.text, 'IsTruncated'), 'false')
  })

  it('applies prefix and delimiter', async () => {
    const response = await client.request({
      method: 'GET', bucket: BUCKET, query: { 'list-type': '2', delimiter: '/' },
    })
    assert.deepEqual(allTags(response.text, 'Key'), ['a.txt', 'z.txt'])
    assert.deepEqual(allTags(response.text, 'Prefix').filter(Boolean), ['dir/', 'other/'])
  })

  it('paginates with a continuation token', async () => {
    const seen = []
    let token
    for (let page = 0; page < 10; page++) {
      const query = { 'list-type': '2', 'max-keys': '2' }
      if (token) query['continuation-token'] = token
      const response = await client.request({ method: 'GET', bucket: BUCKET, query })
      seen.push(...allTags(response.text, 'Key'))
      if (tag(response.text, 'IsTruncated') !== 'true') break
      token = tag(response.text, 'NextContinuationToken')
      assert.ok(token)
    }
    assert.deepEqual(seen, keys)
  })

  it('supports start-after', async () => {
    const response = await client.request({
      method: 'GET', bucket: BUCKET, query: { 'list-type': '2', 'start-after': 'dir/2.txt' },
    })
    assert.deepEqual(allTags(response.text, 'Key'), ['dir/sub/3.txt', 'other/4.txt', 'z.txt'])
  })

  it('serves ListObjects V1 with marker pagination', async () => {
    const first = await client.request({ method: 'GET', bucket: BUCKET, query: { 'max-keys': '2' } })
    assert.equal(first.status, 200)
    assert.deepEqual(allTags(first.text, 'Key'), ['a.txt', 'dir/1.txt'])
    assert.equal(tag(first.text, 'IsTruncated'), 'true')

    const marker = tag(first.text, 'NextMarker')
    assert.equal(marker, 'dir/1.txt')
    const second = await client.request({ method: 'GET', bucket: BUCKET, query: { 'max-keys': '2', marker } })
    assert.deepEqual(allTags(second.text, 'Key'), ['dir/2.txt', 'dir/sub/3.txt'])
  })

  it('url-encodes keys when asked', async () => {
    await client.request({ method: 'PUT', bucket: BUCKET, key: 'with space.txt', body: 'x' })
    const response = await client.request({
      method: 'GET', bucket: BUCKET, query: { 'list-type': '2', 'encoding-type': 'url' },
    })
    assert.ok(allTags(response.text, 'Key').includes('with%20space.txt'))
  })

  it('deletes objects in bulk', async () => {
    const body =
      '<Delete>' +
      ['a.txt', 'z.txt'].map((k) => `<Object><Key>${k}</Key></Object>`).join('') +
      '</Delete>'
    const response = await client.request({
      method: 'POST', bucket: BUCKET, query: { delete: '' }, body,
    })
    assert.equal(response.status, 200)
    assert.deepEqual(allTags(response.text, 'Key'), ['a.txt', 'z.txt'])

    const listing = await client.request({ method: 'GET', bucket: BUCKET, query: { 'list-type': '2' } })
    assert.equal(allTags(listing.text, 'Key').includes('a.txt'), false)
  })

  it('refuses a bulk delete carrying an XXE payload', async () => {
    const response = await client.request({
      method: 'POST', bucket: BUCKET, query: { delete: '' },
      body: '<?xml version="1.0"?><!DOCTYPE d [<!ENTITY x SYSTEM "file:///etc/passwd">]>' +
            '<Delete><Object><Key>&x;</Key></Object></Delete>',
    })
    assert.equal(response.status, 400)
    assert.equal(tag(response.text, 'Code'), 'MalformedXML')
  })
})

describe('multipart over HTTP', () => {
  it('completes a multipart upload and serves it as one object', async () => {
    const key = 'multipart.bin'
    const create = await client.request({
      method: 'POST', bucket: BUCKET, key, query: { uploads: '' },
      headers: { 'content-type': 'application/octet-stream' },
    })
    assert.equal(create.status, 200)
    const uploadId = tag(create.text, 'UploadId')
    assert.ok(uploadId)

    const parts = [randomBytes(64), randomBytes(64), randomBytes(10)]
    const etags = []
    for (const [index, part] of parts.entries()) {
      const response = await client.request({
        method: 'PUT', bucket: BUCKET, key,
        query: { partNumber: String(index + 1), uploadId },
        body: part, payloadMode: 'chunked',
      })
      assert.equal(response.status, 200, `part ${index + 1} failed`)
      etags.push(response.headers.etag)
    }

    const listed = await client.request({ method: 'GET', bucket: BUCKET, key, query: { uploadId } })
    assert.deepEqual(allTags(listed.text, 'PartNumber'), ['1', '2', '3'])

    const complete = await client.request({
      method: 'POST', bucket: BUCKET, key, query: { uploadId },
      body: '<CompleteMultipartUpload>' + etags.map((etag, index) =>
        `<Part><PartNumber>${index + 1}</PartNumber><ETag>${etag}</ETag></Part>`).join('') +
        '</CompleteMultipartUpload>',
    })
    assert.equal(complete.status, 200)
    // Multipart ETag: md5 over the concatenated binary part digests, then -N.
    assert.match(tag(complete.text, 'ETag'), /^"[0-9a-f]{32}-3"$/)

    const whole = Buffer.concat(parts)
    const get = await client.request({ method: 'GET', bucket: BUCKET, key })
    assert.deepEqual(get.body, whole)

    // A range that straddles two parts must still be exact.
    const straddle = await client.request({
      method: 'GET', bucket: BUCKET, key, headers: { range: 'bytes=60-70' },
    })
    assert.equal(straddle.status, 206)
    assert.deepEqual(straddle.body, whole.subarray(60, 71))
  })

  it('lists and aborts an in-flight upload', async () => {
    const key = 'aborted.bin'
    const create = await client.request({ method: 'POST', bucket: BUCKET, key, query: { uploads: '' } })
    const uploadId = tag(create.text, 'UploadId')
    await client.request({
      method: 'PUT', bucket: BUCKET, key, query: { partNumber: '1', uploadId }, body: randomBytes(32),
    })

    const listed = await client.request({ method: 'GET', bucket: BUCKET, query: { uploads: '' } })
    assert.ok(allTags(listed.text, 'UploadId').includes(uploadId))

    assert.equal(
      (await client.request({ method: 'DELETE', bucket: BUCKET, key, query: { uploadId } })).status, 204)
    const after = await client.request({ method: 'GET', bucket: BUCKET, key, query: { uploadId } })
    assert.equal(after.status, 404)
    assert.equal(tag(after.text, 'Code'), 'NoSuchUpload')
  })

  it('rejects completing with a mismatched part ETag', async () => {
    const key = 'badpart.bin'
    const create = await client.request({ method: 'POST', bucket: BUCKET, key, query: { uploads: '' } })
    const uploadId = tag(create.text, 'UploadId')
    await client.request({
      method: 'PUT', bucket: BUCKET, key, query: { partNumber: '1', uploadId }, body: randomBytes(32),
    })
    const response = await client.request({
      method: 'POST', bucket: BUCKET, key, query: { uploadId },
      body: '<CompleteMultipartUpload><Part><PartNumber>1</PartNumber>' +
            '<ETag>"deadbeefdeadbeefdeadbeefdeadbeef"</ETag></Part></CompleteMultipartUpload>',
    })
    assert.equal(response.status, 400)
    assert.equal(tag(response.text, 'Code'), 'InvalidPart')
  })
})

describe('error surface', () => {
  it('renders errors as S3 XML with a dispatchable code', async () => {
    const response = await client.request({ method: 'GET', bucket: 'no-such-bucket-here', key: 'k' })
    assert.equal(response.status, 404)
    assert.match(response.headers['content-type'], /xml/)
    assert.equal(tag(response.text, 'Code'), 'NoSuchBucket')
    assert.ok(tag(response.text, 'RequestId'))
    assert.equal(tag(response.text, 'Resource'), '/no-such-bucket-here/k')
  })

  it('reports NotImplemented for out-of-scope subresources', async () => {
    for (const subresource of ['acl', 'replication', 'website', 'object-lock']) {
      const response = await client.request({
        method: 'GET', bucket: BUCKET, query: { [subresource]: '' },
      })
      assert.equal(response.status, 501, subresource)
      assert.equal(tag(response.text, 'Code'), 'NotImplemented')
    }
  })

  it('rejects an unsupported method', async () => {
    const response = await client.request({ method: 'PATCH', bucket: BUCKET, key: 'k', body: 'x' })
    assert.equal(response.status, 405)
  })
})
