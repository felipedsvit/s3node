import { createHash } from 'node:crypto'
import { Transform } from 'node:stream'
import { S3Error } from '../errors.js'
import {
  EMPTY_SHA256,
  calculateSignature,
  chunkStringToSign,
  signaturesMatch,
  trailerStringToSign,
} from './sigv4.js'

const CRLF = Buffer.from('\r\n')
const MAX_LINE_BYTES = 8192
const MAX_CHUNK_BYTES = 1024 * 1024 * 1024

/**
 * Strips `aws-chunked` framing from a request body.
 *
 * The aws-cli does not send object bytes raw — it wraps them in
 * `<hex-size>;chunk-signature=<sig>\r\n<data>\r\n` frames. Writing the request
 * body straight to disk therefore stores the framing alongside the data and
 * silently corrupts every object the CLI uploads. See docs/plan.md 4.1.
 *
 * Chunk signatures are verified as each frame completes. Data is forwarded
 * before its frame is verified, which is safe because object metadata is only
 * committed after the whole body succeeds — a failed verification destroys the
 * stream and leaves nothing but an orphaned temp file (docs/plan.md 8).
 */
export class ChunkedDecoder extends Transform {
  constructor({
    signed = false,
    seedSignature = null,
    signingKey = null,
    scope = null,
    amzDate = null,
    expectedLength = null,
  } = {}, options = {}) {
    super(options)
    this.signed = signed
    this.previousSignature = seedSignature
    this.signingKey = signingKey
    this.scope = scope
    this.amzDate = amzDate
    this.expectedLength = expectedLength

    this.trailers = Object.create(null)
    this.decodedLength = 0

    this._pending = Buffer.alloc(0)
    this._state = 'size'
    this._remaining = 0
    this._chunkHash = null
    this._chunkSignature = null
    this._trailerBytes = ''
  }

  _transform(chunk, _encoding, callback) {
    this._pending = this._pending.length ? Buffer.concat([this._pending, chunk]) : chunk
    try {
      this._drain()
      callback()
    } catch (err) {
      callback(err)
    }
  }

  _flush(callback) {
    try {
      this._drain()
      if (this._state === 'trailer' && this._pending.length) {
        this._consumeTrailerLine(this._pending.toString('latin1').replace(/\r?\n$/, ''))
        this._pending = Buffer.alloc(0)
      }
      if (this._state !== 'done' && this._state !== 'trailer') {
        throw new S3Error('IncompleteBody', 'The request body terminated before the final chunk')
      }
      this._verifyTrailerSignature()
      if (this.expectedLength !== null && this.decodedLength !== this.expectedLength) {
        throw new S3Error(
          'IncompleteBody',
          `Decoded body length ${this.decodedLength} does not match x-amz-decoded-content-length ${this.expectedLength}`,
        )
      }
      callback()
    } catch (err) {
      callback(err)
    }
  }

  _takeLine() {
    const index = this._pending.indexOf(CRLF)
    if (index === -1) {
      if (this._pending.length > MAX_LINE_BYTES) {
        throw new S3Error('InvalidRequest', 'Malformed aws-chunked framing: line too long')
      }
      return null
    }
    const line = this._pending.subarray(0, index).toString('latin1')
    this._pending = this._pending.subarray(index + 2)
    return line
  }

  _drain() {
    for (;;) {
      if (this._state === 'done') return

      if (this._state === 'size') {
        const line = this._takeLine()
        if (line === null) return
        const [sizeField, ...extensions] = line.split(';')
        const size = Number.parseInt(sizeField.trim(), 16)
        if (!Number.isInteger(size) || size < 0 || size > MAX_CHUNK_BYTES) {
          throw new S3Error('InvalidRequest', `Malformed aws-chunked framing: bad chunk size "${sizeField}"`)
        }
        this._chunkSignature = null
        for (const extension of extensions) {
          const [name, value] = extension.split('=')
          if (name?.trim() === 'chunk-signature') this._chunkSignature = value?.trim() ?? null
        }
        if (this.signed && !this._chunkSignature) {
          throw new S3Error('SignatureDoesNotMatch', 'Chunk is missing chunk-signature')
        }
        if (size === 0) {
          this._verifyChunk(EMPTY_SHA256)
          this._state = 'trailer'
          continue
        }
        this._remaining = size
        this._chunkHash = this.signed ? createHash('sha256') : null
        this._state = 'data'
        continue
      }

      if (this._state === 'data') {
        if (this._pending.length === 0) return
        const take = Math.min(this._remaining, this._pending.length)
        const data = this._pending.subarray(0, take)
        this._pending = this._pending.subarray(take)
        this._remaining -= take
        this.decodedLength += take
        if (this._chunkHash) this._chunkHash.update(data)
        this.push(data)
        if (this._remaining === 0) this._state = 'chunk-end'
        continue
      }

      if (this._state === 'chunk-end') {
        if (this._pending.length < 2) return
        if (this._pending[0] !== 0x0d || this._pending[1] !== 0x0a) {
          throw new S3Error('InvalidRequest', 'Malformed aws-chunked framing: missing CRLF after chunk data')
        }
        this._pending = this._pending.subarray(2)
        this._verifyChunk(this._chunkHash ? this._chunkHash.digest('hex') : null)
        this._state = 'size'
        continue
      }

      if (this._state === 'trailer') {
        const line = this._takeLine()
        if (line === null) return
        if (line === '') {
          this._state = 'done'
          return
        }
        this._consumeTrailerLine(line)
        continue
      }

      return
    }
  }

  _consumeTrailerLine(line) {
    if (!line) return
    const separator = line.indexOf(':')
    if (separator === -1) {
      throw new S3Error('InvalidRequest', 'Malformed aws-chunked trailer')
    }
    const name = line.slice(0, separator).trim().toLowerCase()
    const value = line.slice(separator + 1).trim()
    if (name === 'x-amz-trailer-signature') {
      this._trailerSignature = value
      return
    }
    this.trailers[name] = value
    this._trailerBytes += `${name}:${value}\n`
  }

  _verifyChunk(chunkSha256) {
    if (!this.signed) return
    const stringToSign = chunkStringToSign({
      amzDate: this.amzDate,
      scope: this.scope,
      previousSignature: this.previousSignature,
      chunkSha256,
    })
    const expected = calculateSignature(this.signingKey, stringToSign)
    if (!signaturesMatch(expected, this._chunkSignature)) {
      throw new S3Error('SignatureDoesNotMatch', 'The chunk signature does not match')
    }
    this.previousSignature = expected
  }

  _verifyTrailerSignature() {
    if (!this.signed || !this._trailerSignature) return
    const stringToSign = trailerStringToSign({
      amzDate: this.amzDate,
      scope: this.scope,
      previousSignature: this.previousSignature,
      trailerSha256: createHash('sha256').update(this._trailerBytes, 'utf8').digest('hex'),
    })
    const expected = calculateSignature(this.signingKey, stringToSign)
    if (!signaturesMatch(expected, this._trailerSignature)) {
      throw new S3Error('SignatureDoesNotMatch', 'The trailer signature does not match')
    }
  }
}

/**
 * Encodes a body as `aws-chunked`. Used by the test client to exercise the
 * decoder the way the aws-cli does.
 */
export function encodeChunked(body, { signed = false, seedSignature, signingKey, scope, amzDate, chunkSize = 65536, trailers = null } = {}) {
  const source = Buffer.isBuffer(body) ? body : Buffer.from(body)
  const frames = []
  let previousSignature = seedSignature

  const frame = (data) => {
    let extension = ''
    if (signed) {
      const stringToSign = chunkStringToSign({
        amzDate,
        scope,
        previousSignature,
        chunkSha256: createHash('sha256').update(data).digest('hex'),
      })
      previousSignature = calculateSignature(signingKey, stringToSign)
      extension = `;chunk-signature=${previousSignature}`
    }
    frames.push(Buffer.from(`${data.length.toString(16)}${extension}\r\n`), data, CRLF)
  }

  for (let offset = 0; offset < source.length; offset += chunkSize) {
    frame(source.subarray(offset, Math.min(offset + chunkSize, source.length)))
  }

  // Final zero-length frame.
  let finalExtension = ''
  if (signed) {
    const stringToSign = chunkStringToSign({
      amzDate, scope, previousSignature, chunkSha256: EMPTY_SHA256,
    })
    previousSignature = calculateSignature(signingKey, stringToSign)
    finalExtension = `;chunk-signature=${previousSignature}`
  }
  frames.push(Buffer.from(`0${finalExtension}\r\n`))

  if (trailers) {
    let trailerBytes = ''
    for (const [name, value] of Object.entries(trailers)) {
      frames.push(Buffer.from(`${name}:${value}\r\n`))
      trailerBytes += `${name}:${value}\n`
    }
    if (signed) {
      const stringToSign = trailerStringToSign({
        amzDate,
        scope,
        previousSignature,
        trailerSha256: createHash('sha256').update(trailerBytes, 'utf8').digest('hex'),
      })
      frames.push(Buffer.from(`x-amz-trailer-signature:${calculateSignature(signingKey, stringToSign)}\r\n`))
    }
  }

  frames.push(CRLF)
  return Buffer.concat(frames)
}
