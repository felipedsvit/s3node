import { createHash } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { encodeChunked } from '../../src/auth/chunked.js'
import {
  ALGORITHM,
  EMPTY_SHA256,
  STREAMING_SIGNED,
  STREAMING_UNSIGNED_TRAILER,
  buildCanonicalRequest,
  buildStringToSign,
  calculateSignature,
  canonicalQueryString,
  deriveSigningKey,
  uriEncode,
} from '../../src/auth/sigv4.js'

const PLACEHOLDER_SIGNATURE = '0'.repeat(64)

function amzTimestamp(date = new Date()) {
  return `${date.toISOString().replace(/[-:]/g, '').split('.')[0]}Z`
}

/**
 * Minimal SigV4 client, standing in for the aws-cli / SDK in tests. It signs
 * the same way real clients do, including the `aws-chunked` body framing.
 */
export class TestClient {
  constructor({ endpoint, accessKeyId, secretAccessKey, region = 'us-east-1' }) {
    const url = new URL(endpoint)
    this.host = url.hostname
    this.port = Number(url.port)
    this.accessKeyId = accessKeyId
    this.secretAccessKey = secretAccessKey
    this.region = region
  }

  _sign({ method, path, queryPairs, headers, payloadHash, amzDate }) {
    const dateStamp = amzDate.slice(0, 8)
    const scope = `${dateStamp}/${this.region}/s3/aws4_request`
    const signedHeaders = Object.keys(headers).map((h) => h.toLowerCase()).sort()
    const canonicalRequest = buildCanonicalRequest({
      method, canonicalUri: path, queryPairs, headers, signedHeaders, payloadHash,
    })
    const stringToSign = buildStringToSign({ amzDate, scope, canonicalRequest })
    const signingKey = deriveSigningKey(this.secretAccessKey, dateStamp, this.region, 's3', this.accessKeyId)
    const signature = calculateSignature(signingKey, stringToSign)
    return {
      scope,
      signature,
      signingKey,
      authorization:
        `${ALGORITHM} Credential=${this.accessKeyId}/${scope}, ` +
        `SignedHeaders=${signedHeaders.join(';')}, Signature=${signature}`,
    }
  }

  /**
   * @param {object} options
   * @param {'signed'|'unsigned'|'chunked'|'chunked-trailer'} [options.payloadMode]
   */
  async request({
    method = 'GET',
    bucket = '',
    key = '',
    query = {},
    headers = {},
    body = null,
    payloadMode = 'signed',
    trailers = null,
    chunkSize = 65536,
    now = new Date(),
    overrideSignature = null,
    waitForContinue = false,
  } = {}) {
    const amzDate = amzTimestamp(now)
    const rawBody = body === null ? Buffer.alloc(0)
      : Buffer.isBuffer(body) ? body : Buffer.from(body)

    let path = '/'
    if (bucket) path = key ? `/${bucket}/${uriEncode(key, false)}` : `/${bucket}`

    const queryPairs = Object.entries(query).map(([name, value]) => [name, value ?? ''])
    const queryString = canonicalQueryString(queryPairs)

    const signedHeaders = {
      host: this.port ? `${this.host}:${this.port}` : this.host,
      'x-amz-date': amzDate,
    }
    for (const [name, value] of Object.entries(headers)) {
      signedHeaders[name.toLowerCase()] = String(value)
    }

    let payloadHash
    let wireBody = rawBody

    if (payloadMode === 'unsigned') {
      payloadHash = 'UNSIGNED-PAYLOAD'
    } else if (payloadMode === 'chunked' || payloadMode === 'chunked-trailer') {
      payloadHash = payloadMode === 'chunked' ? STREAMING_SIGNED : STREAMING_UNSIGNED_TRAILER
      signedHeaders['content-encoding'] = 'aws-chunked'
      signedHeaders['x-amz-decoded-content-length'] = String(rawBody.length)
      // Signatures are fixed-width, so encoding with a placeholder seed yields
      // the exact Content-Length the real encoding will have.
      const probe = encodeChunked(rawBody, {
        signed: payloadMode === 'chunked',
        seedSignature: PLACEHOLDER_SIGNATURE,
        signingKey: Buffer.alloc(32),
        scope: 'x', amzDate, chunkSize, trailers,
      })
      signedHeaders['content-length'] = String(probe.length)
    } else {
      payloadHash = rawBody.length === 0 ? EMPTY_SHA256 : createHash('sha256').update(rawBody).digest('hex')
      if (rawBody.length > 0) signedHeaders['content-length'] = String(rawBody.length)
    }
    signedHeaders['x-amz-content-sha256'] = payloadHash

    const signed = this._sign({ method, path, queryPairs, headers: signedHeaders, payloadHash, amzDate })

    if (payloadMode === 'chunked' || payloadMode === 'chunked-trailer') {
      wireBody = encodeChunked(rawBody, {
        signed: payloadMode === 'chunked',
        seedSignature: signed.signature,
        signingKey: signed.signingKey,
        scope: signed.scope,
        amzDate,
        chunkSize,
        trailers,
      })
    }

    const outgoing = {
      ...signedHeaders,
      authorization: overrideSignature
        ? signed.authorization.replace(/Signature=.*$/, `Signature=${overrideSignature}`)
        : signed.authorization,
    }

    return this._send({
      method,
      path: queryString ? `${path}?${queryString}` : path,
      headers: outgoing,
      body: wireBody,
      waitForContinue,
    })
  }

  /** Build a presigned URL (SigV4 in the query string). */
  presign({ method = 'GET', bucket, key, expiresIn = 900, now = new Date() }) {
    const amzDate = amzTimestamp(now)
    const dateStamp = amzDate.slice(0, 8)
    const scope = `${dateStamp}/${this.region}/s3/aws4_request`
    const path = key ? `/${bucket}/${uriEncode(key, false)}` : `/${bucket}`
    const host = this.port ? `${this.host}:${this.port}` : this.host

    const queryPairs = [
      ['X-Amz-Algorithm', ALGORITHM],
      ['X-Amz-Credential', `${this.accessKeyId}/${scope}`],
      ['X-Amz-Date', amzDate],
      ['X-Amz-Expires', String(expiresIn)],
      ['X-Amz-SignedHeaders', 'host'],
    ]
    const canonicalRequest = buildCanonicalRequest({
      method, canonicalUri: path, queryPairs,
      headers: { host }, signedHeaders: ['host'], payloadHash: 'UNSIGNED-PAYLOAD',
    })
    const stringToSign = buildStringToSign({ amzDate, scope, canonicalRequest })
    const signature = calculateSignature(
      deriveSigningKey(this.secretAccessKey, dateStamp, this.region, 's3', this.accessKeyId),
      stringToSign,
    )
    const search = `${canonicalQueryString(queryPairs)}&X-Amz-Signature=${signature}`
    return { path: `${path}?${search}`, url: `http://${host}${path}?${search}`, method }
  }

  send(options) {
    return this._send(options)
  }

  _send({ method, path, headers, body, waitForContinue = false }) {
    return new Promise((resolve, reject) => {
      let continueReceived = false
      const req = httpRequest(
        { host: this.host, port: this.port, method, path, headers },
        (res) => {
          const chunks = []
          res.on('data', (chunk) => chunks.push(chunk))
          res.on('end', () => resolve({
            status: res.statusCode,
            headers: res.headers,
            continueReceived,
            body: Buffer.concat(chunks),
            get text() { return Buffer.concat(chunks).toString('utf8') },
          }))
        },
      )
      req.on('error', reject)
      req.on('continue', () => {
        continueReceived = true
        if (waitForContinue) {
          if (body && body.length) req.write(body)
          req.end()
        }
      })
      if (waitForContinue) return
      if (body && body.length) req.write(body)
      req.end()
    })
  }
}
