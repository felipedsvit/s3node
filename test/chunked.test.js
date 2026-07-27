import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { describe, it } from 'node:test'
import { ChunkedDecoder, encodeChunked } from '../src/auth/chunked.js'
import { Crc32 } from '../src/util/crc.js'
import { deriveSigningKey } from '../src/auth/sigv4.js'

const SCOPE = '20260727/us-east-1/s3/aws4_request'
const AMZ_DATE = '20260727T000000Z'
const SIGNING_KEY = deriveSigningKey('secret', '20260727', 'us-east-1', 's3', 'AKIDTEST')
const SEED = 'a'.repeat(64)

const signedOptions = {
  signed: true, seedSignature: SEED, signingKey: SIGNING_KEY, scope: SCOPE, amzDate: AMZ_DATE,
}

async function decode(input, options, sliceSize = input.length) {
  const decoder = new ChunkedDecoder(options)
  const chunks = []
  const finished = new Promise((resolve, reject) => {
    decoder.on('data', (chunk) => chunks.push(chunk))
    decoder.on('end', resolve)
    decoder.on('error', reject)
  })
  for (let offset = 0; offset < input.length; offset += sliceSize) {
    decoder.write(input.subarray(offset, offset + sliceSize))
  }
  decoder.end()
  await finished
  return { body: Buffer.concat(chunks), decoder }
}

describe('ChunkedDecoder', () => {
  it('strips framing from an unsigned body', async () => {
    const payload = Buffer.from('hello world')
    const framed = encodeChunked(payload, { signed: false })

    // The framing really is present on the wire: writing it straight to disk
    // is what corrupts objects (docs/plan.md 4.1).
    assert.equal(framed.includes(payload), true)
    assert.notEqual(framed.length, payload.length)

    const { body } = await decode(framed, {})
    assert.deepEqual(body, payload)
  })

  it('round-trips a multi-chunk body', async () => {
    const payload = randomBytes(200_000)
    const framed = encodeChunked(payload, { signed: false, chunkSize: 65536 })
    const { body, decoder } = await decode(framed, {})
    assert.deepEqual(body, payload)
    assert.equal(decoder.decodedLength, payload.length)
  })

  it('reassembles correctly when frames straddle transform boundaries', async () => {
    const payload = randomBytes(5000)
    const framed = encodeChunked(payload, { signed: false, chunkSize: 512 })
    for (const sliceSize of [1, 3, 17, 511, 4096]) {
      const { body } = await decode(framed, {}, sliceSize)
      assert.deepEqual(body, payload, `failed at slice size ${sliceSize}`)
    }
  })

  it('handles an empty body', async () => {
    const framed = encodeChunked(Buffer.alloc(0), { signed: false })
    const { body, decoder } = await decode(framed, {})
    assert.equal(body.length, 0)
    assert.equal(decoder.decodedLength, 0)
  })

  it('verifies the chunk signature chain', async () => {
    const payload = randomBytes(150_000)
    const framed = encodeChunked(payload, { ...signedOptions, chunkSize: 65536 })
    const { body } = await decode(framed, signedOptions)
    assert.deepEqual(body, payload)
  })

  it('rejects a tampered chunk signature', async () => {
    const payload = Buffer.from('hello world')
    const framed = encodeChunked(payload, signedOptions)
    const tampered = Buffer.from(
      framed.toString('latin1').replace(/chunk-signature=./, 'chunk-signature=0'), 'latin1')
    await assert.rejects(
      decode(tampered, signedOptions),
      (err) => err.code === 'SignatureDoesNotMatch',
    )
  })

  it('rejects a body whose bytes were altered under a valid signature chain', async () => {
    const payload = Buffer.from('hello world')
    const framed = encodeChunked(payload, signedOptions)
    const index = framed.indexOf(payload)
    const tampered = Buffer.from(framed)
    tampered[index] ^= 0xff
    await assert.rejects(decode(tampered, signedOptions), (err) => err.code === 'SignatureDoesNotMatch')
  })

  it('rejects a signed body that omits chunk signatures', async () => {
    const framed = encodeChunked(Buffer.from('hi'), { signed: false })
    await assert.rejects(decode(framed, signedOptions), (err) => err.code === 'SignatureDoesNotMatch')
  })

  it('collects trailers', async () => {
    const payload = Buffer.from('hello world')
    const checksum = new Crc32().update(payload).digest('base64')
    const framed = encodeChunked(payload, {
      signed: false,
      trailers: { 'x-amz-checksum-crc32': checksum },
    })
    const { body, decoder } = await decode(framed, {})
    assert.deepEqual(body, payload)
    assert.equal(decoder.trailers['x-amz-checksum-crc32'], checksum)
  })

  it('verifies the trailer signature', async () => {
    const payload = Buffer.from('hello world')
    const framed = encodeChunked(payload, {
      ...signedOptions,
      trailers: { 'x-amz-checksum-crc32': new Crc32().update(payload).digest('base64') },
    })
    const { decoder } = await decode(framed, signedOptions)
    assert.ok(decoder.trailers['x-amz-checksum-crc32'])
  })

  it('rejects a decoded length that disagrees with the declared one', async () => {
    const framed = encodeChunked(Buffer.from('hello'), { signed: false })
    await assert.rejects(
      decode(framed, { expectedLength: 999 }),
      (err) => err.code === 'IncompleteBody',
    )
  })

  it('rejects a truncated body', async () => {
    const framed = encodeChunked(Buffer.from('hello world'), { signed: false })
    await assert.rejects(
      decode(framed.subarray(0, framed.length - 8), {}),
      (err) => err.code === 'IncompleteBody' || err.code === 'InvalidRequest',
    )
  })

  it('rejects a malformed chunk size', async () => {
    await assert.rejects(
      decode(Buffer.from('zz\r\ndata\r\n0\r\n\r\n'), {}),
      (err) => err.code === 'InvalidRequest',
    )
  })

  it('rejects framing with a missing CRLF after chunk data', async () => {
    await assert.rejects(
      decode(Buffer.from('5\r\nhelloXX0\r\n\r\n'), {}),
      (err) => err.code === 'InvalidRequest',
    )
  })
})
