import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Crc32, Crc32c } from '../dist/src/util/crc.js'
import { HashingStream, multipartEtag } from '../dist/src/util/hash.js'
import { compareKeys, keySuccessor, prefixUpperBound } from '../dist/src/util/bytes.js'
import { parseRange, evaluatePreconditions, parseQueryPairs } from '../dist/src/http.js'
import { S3Error } from '../dist/src/errors.js'

describe('CRC', () => {
  // 0xCBF43926 / 0xE3069283 over "123456789" are the standard check values.
  it('matches the CRC32 check value', () => {
    assert.equal(new Crc32().update(Buffer.from('123456789')).value(), 0xcbf43926)
  })

  it('matches the CRC32C check value', () => {
    assert.equal(new Crc32c().update(Buffer.from('123456789')).value(), 0xe3069283)
  })

  it('is order-independent across chunk boundaries', () => {
    const whole = new Crc32().update(Buffer.from('123456789')).value()
    const split = new Crc32().update(Buffer.from('1234')).update(Buffer.from('56789')).value()
    assert.equal(whole, split)
  })

  it('encodes digests as big-endian base64', () => {
    assert.equal(new Crc32().update(Buffer.from('123456789')).digest('hex'), 'cbf43926')
  })
})

describe('byte ordering', () => {
  it('orders keys by UTF-8 bytes, not UTF-16 code units', () => {
    // JavaScript string comparison puts the emoji first because its leading
    // surrogate (0xD83D) is below 0xFFFD; UTF-8 byte order is the opposite.
    assert.equal('�' < '\u{1F600}', false)
    assert.equal(compareKeys('�', '\u{1F600}') < 0, true)
  })

  it('computes a prefix upper bound', () => {
    assert.equal(prefixUpperBound('a/').toString('utf8'), 'a0')
    assert.equal(prefixUpperBound(''), null)
  })

  it('carries when the last prefix byte is 0xFF', () => {
    assert.deepEqual([...prefixUpperBound(Buffer.from([0x61, 0xff]))], [0x62])
    assert.equal(prefixUpperBound(Buffer.from([0xff, 0xff])), null)
  })

  it('produces a successor greater than the key but below its children', () => {
    const key = Buffer.from('a')
    assert.equal(Buffer.compare(keySuccessor(key), key) > 0, true)
    assert.equal(Buffer.compare(keySuccessor(key), Buffer.from('a/b')) < 0, true)
  })
})

describe('HashingStream', () => {
  it('computes every requested digest in one pass', async () => {
    const hasher = new HashingStream(['md5', 'sha256', 'crc32'])
    hasher.end(Buffer.from('hello'))
    for await (const _ of hasher) { /* drain */ }
    assert.equal(hasher.bytesWritten, 5)
    assert.equal(hasher.digest('md5', 'hex'), '5d41402abc4b2a76b9719d911017c592')
    assert.equal(
      hasher.digest('sha256', 'hex'),
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    )
  })

  it('returns the same digest when asked twice', async () => {
    const hasher = new HashingStream(['md5'])
    hasher.end(Buffer.from('hello'))
    for await (const _ of hasher) { /* drain */ }
    assert.equal(hasher.digest('md5', 'hex'), hasher.digest('md5', 'hex'))
    assert.equal(hasher.digest('md5', 'base64'), 'XUFAKrxLKna5cZ2REBfFkg==')
  })
})

describe('multipartEtag', () => {
  it('hashes the concatenated binary part digests and appends the count', () => {
    const parts = ['5d41402abc4b2a76b9719d911017c592', 'd41d8cd98f00b204e9800998ecf8427e']
    const etag = multipartEtag(parts)
    assert.match(etag, /^[0-9a-f]{32}-2$/)
    // A different part order must produce a different ETag.
    assert.notEqual(etag, multipartEtag([...parts].reverse()))
  })
})

describe('parseRange', () => {
  it('parses closed, open and suffix ranges', () => {
    assert.deepEqual(parseRange('bytes=0-9', 100), { start: 0, end: 9 })
    assert.deepEqual(parseRange('bytes=5-', 100), { start: 5, end: 99 })
    assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 })
  })

  it('clamps an end past the object size', () => {
    assert.deepEqual(parseRange('bytes=0-999', 10), { start: 0, end: 9 })
  })

  it('ignores unparseable ranges', () => {
    assert.equal(parseRange('bytes=abc', 100), null)
    assert.equal(parseRange(undefined, 100), null)
  })

  it('rejects an unsatisfiable range', () => {
    assert.throws(() => parseRange('bytes=200-300', 100), (err) => err.code === 'InvalidRange')
  })
})

describe('evaluatePreconditions', () => {
  const record = { etag: '"abc"', lastModified: new Date('2026-01-01T00:00:00Z') }

  it('passes a matching If-Match', () => {
    assert.equal(evaluatePreconditions({ 'if-match': '"abc"' }, record), 'ok')
  })

  it('fails a non-matching If-Match', () => {
    assert.throws(() => evaluatePreconditions({ 'if-match': '"zzz"' }, record),
      (err) => err instanceof S3Error && err.statusCode === 412)
  })

  it('reports not-modified for a matching If-None-Match', () => {
    assert.equal(evaluatePreconditions({ 'if-none-match': '"abc"' }, record), 'not-modified')
    assert.equal(evaluatePreconditions({ 'if-none-match': '*' }, record), 'not-modified')
  })

  it('lets If-Match take precedence over If-Unmodified-Since', () => {
    assert.equal(evaluatePreconditions({
      'if-match': '"abc"',
      'if-unmodified-since': new Date('2020-01-01T00:00:00Z').toUTCString(),
    }, record), 'ok')
  })

  it('reports not-modified for If-Modified-Since at or after the mtime', () => {
    assert.equal(evaluatePreconditions(
      { 'if-modified-since': record.lastModified.toUTCString() }, record), 'not-modified')
  })
})

describe('parseQueryPairs', () => {
  it('keeps repeated names and decodes values', () => {
    assert.deepEqual(parseQueryPairs('a=1&a=2&b=x%20y'), [['a', '1'], ['a', '2'], ['b', 'x y']])
  })

  it('treats a bare flag as an empty value', () => {
    assert.deepEqual(parseQueryPairs('uploads'), [['uploads', '']])
  })
})
