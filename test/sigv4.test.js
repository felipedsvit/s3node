import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'
import {
  EMPTY_SHA256,
  buildCanonicalRequest,
  buildStringToSign,
  calculateSignature,
  canonicalQueryString,
  deriveSigningKey,
  normalizeHeaderValue,
  parseAmzDate,
  signaturesMatch,
  uriEncode,
} from '../dist/src/auth/sigv4.js'

describe('uriEncode', () => {
  it('leaves RFC 3986 unreserved characters alone', () => {
    assert.equal(uriEncode('abcXYZ019-._~'), 'abcXYZ019-._~')
  })

  it('encodes space as %20, never as +', () => {
    assert.equal(uriEncode('a b'), 'a%20b')
  })

  it("encodes !'()* which encodeURIComponent leaves untouched", () => {
    assert.equal(uriEncode("!'()*"), '%21%27%28%29%2A')
    assert.notEqual(uriEncode("!'()*"), encodeURIComponent("!'()*"))
  })

  it('encodes slashes only when asked', () => {
    assert.equal(uriEncode('a/b'), 'a%2Fb')
    assert.equal(uriEncode('a/b', false), 'a/b')
  })

  it('percent-encodes multibyte UTF-8 per byte', () => {
    assert.equal(uriEncode('é'), '%C3%A9')
  })
})

describe('canonicalQueryString', () => {
  it('sorts by encoded name then value', () => {
    assert.equal(
      canonicalQueryString([['b', '2'], ['a', '1'], ['a', '0']]),
      'a=0&a=1&b=2',
    )
  })

  it('includes valueless parameters with an empty value', () => {
    assert.equal(canonicalQueryString([['uploads', '']]), 'uploads=')
  })
})

describe('normalizeHeaderValue', () => {
  it('trims and collapses internal whitespace', () => {
    assert.equal(normalizeHeaderValue('  a   b  '), 'a b')
  })
})

describe('parseAmzDate', () => {
  it('parses the compact ISO form', () => {
    assert.equal(parseAmzDate('20130524T000000Z').toISOString(), '2013-05-24T00:00:00.000Z')
  })

  it('rejects anything else', () => {
    assert.equal(parseAmzDate('2013-05-24T00:00:00Z'), null)
    assert.equal(parseAmzDate(undefined), null)
  })
})

describe('empty payload constant', () => {
  it('matches SHA-256 of the empty string', () => {
    assert.equal(createHash('sha256').update('').digest('hex'), EMPTY_SHA256)
  })
})

/**
 * Known-answer vectors from the AWS "Signature Calculations for the
 * Authorization Header" documentation (GET Object example). These pin the
 * implementation to the published values rather than to itself.
 */
describe('AWS documented GET Object vector', () => {
  const accessKeyId = 'AKIAIOSFODNN7EXAMPLE'
  const secretAccessKey = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
  const amzDate = '20130524T000000Z'
  const scope = '20130524/us-east-1/s3/aws4_request'

  const canonicalRequest = buildCanonicalRequest({
    method: 'GET',
    canonicalUri: '/test.txt',
    queryPairs: [],
    headers: {
      host: 'examplebucket.s3.amazonaws.com',
      range: 'bytes=0-9',
      'x-amz-content-sha256': EMPTY_SHA256,
      'x-amz-date': amzDate,
    },
    signedHeaders: ['host', 'range', 'x-amz-content-sha256', 'x-amz-date'],
    payloadHash: EMPTY_SHA256,
  })

  it('builds the documented canonical request', () => {
    assert.equal(canonicalRequest, [
      'GET',
      '/test.txt',
      '',
      'host:examplebucket.s3.amazonaws.com',
      'range:bytes=0-9',
      `x-amz-content-sha256:${EMPTY_SHA256}`,
      `x-amz-date:${amzDate}`,
      '',
      'host;range;x-amz-content-sha256;x-amz-date',
      EMPTY_SHA256,
    ].join('\n'))
  })

  it('hashes the canonical request to the documented digest', () => {
    assert.equal(
      createHash('sha256').update(canonicalRequest).digest('hex'),
      '7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972',
    )
  })

  it('produces the documented signature', () => {
    const stringToSign = buildStringToSign({ amzDate, scope, canonicalRequest })
    const signingKey = deriveSigningKey(secretAccessKey, '20130524', 'us-east-1', 's3', accessKeyId)
    assert.equal(
      calculateSignature(signingKey, stringToSign),
      'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    )
  })
})

describe('deriveSigningKey caching', () => {
  it('does not serve a stale key after the secret changes', () => {
    const a = deriveSigningKey('secret-one', '20260101', 'us-east-1', 's3', 'AKIDTEST')
    const b = deriveSigningKey('secret-two', '20260101', 'us-east-1', 's3', 'AKIDTEST')
    assert.notEqual(a.toString('hex'), b.toString('hex'))
  })

  it('returns the same key for identical inputs', () => {
    const a = deriveSigningKey('secret-one', '20260101', 'us-east-1', 's3', 'AKIDTEST')
    const b = deriveSigningKey('secret-one', '20260101', 'us-east-1', 's3', 'AKIDTEST')
    assert.equal(a.toString('hex'), b.toString('hex'))
  })
})

describe('signaturesMatch', () => {
  it('compares equal signatures', () => {
    assert.equal(signaturesMatch('a'.repeat(64), 'a'.repeat(64)), true)
  })

  it('rejects different signatures and length mismatches without throwing', () => {
    assert.equal(signaturesMatch('a'.repeat(64), 'b'.repeat(64)), false)
    assert.equal(signaturesMatch('a'.repeat(64), 'short'), false)
    assert.equal(signaturesMatch('a'.repeat(64), undefined), false)
  })
})
