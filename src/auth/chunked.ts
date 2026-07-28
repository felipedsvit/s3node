import { createHash } from 'node:crypto'
import { Transform, type TransformCallback } from 'node:stream'
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

export class ChunkedDecoder extends Transform {
  signed: boolean
  previousSignature: string | null
  signingKey: Buffer | null
  scope: string | null
  amzDate: string | null
  expectedLength: number | null
  trailers: Record<string, string>
  decodedLength: number

  _pending: Buffer
  _state: string
  _remaining: number
  _chunkHash: ReturnType<typeof createHash> | null
  _chunkSignature: string | null
  _trailerBytes: string
  private _trailerSignature: string | undefined

  constructor({
    signed = false,
    seedSignature = null,
    signingKey = null,
    scope = null,
    amzDate = null,
    expectedLength = null,
  }: {
    signed?: boolean
    seedSignature?: string | null
    signingKey?: Buffer | null
    scope?: string | null
    amzDate?: string | null
    expectedLength?: number | null
  } = {}, options = {}) {
    super(options)
    this.signed = signed
    this.previousSignature = seedSignature
    this.signingKey = signingKey
    this.scope = scope
    this.amzDate = amzDate
    this.expectedLength = expectedLength

    this.trailers = Object.create(null) as Record<string, string>
    this.decodedLength = 0

    this._pending = Buffer.alloc(0)
    this._state = 'size'
    this._remaining = 0
    this._chunkHash = null
    this._chunkSignature = null
    this._trailerBytes = ''
    this._trailerSignature = undefined
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this._pending = this._pending.length ? Buffer.concat([this._pending, chunk]) : chunk
    try {
      this._drain()
      callback()
    } catch (err) {
      callback(err as Error)
    }
  }

  override _flush(callback: TransformCallback): void {
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
      callback(err as Error)
    }
  }

  _takeLine(): string | null {
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

  _drain(): void {
    for (;;) {
      if (this._state === 'done') return

      if (this._state === 'size') {
        const line = this._takeLine()
        if (line === null) return
        const [sizeField, ...extensions] = line.split(';')
        const size = Number.parseInt(sizeField!.trim(), 16)
        if (!Number.isInteger(size) || size < 0 || size > MAX_CHUNK_BYTES) {
          throw new S3Error('InvalidRequest', `Malformed aws-chunked framing: bad chunk size "${sizeField}"`)
        }
        this._chunkSignature = null
        for (const extension of extensions) {
          const eq = extension.indexOf('=')
          if (eq === -1) continue
          const name = extension.slice(0, eq).trim()
          if (name === 'chunk-signature') this._chunkSignature = extension.slice(eq + 1).trim() ?? null
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
        this._verifyChunk(this._chunkHash ? this._chunkHash.digest('hex') : EMPTY_SHA256)
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

  _consumeTrailerLine(line: string): void {
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

  _verifyChunk(chunkSha256: string): void {
    if (!this.signed) return
    const stringToSign = chunkStringToSign({
      amzDate: this.amzDate,
      scope: this.scope,
      previousSignature: this.previousSignature!,
      chunkSha256,
    })
    const expected = calculateSignature(this.signingKey!, stringToSign)
    if (!signaturesMatch(expected, this._chunkSignature)) {
      throw new S3Error('SignatureDoesNotMatch', 'The chunk signature does not match')
    }
    this.previousSignature = expected
  }

  _verifyTrailerSignature(): void {
    if (!this.signed || !this._trailerSignature) return
    const stringToSign = trailerStringToSign({
      amzDate: this.amzDate,
      scope: this.scope,
      previousSignature: this.previousSignature!,
      trailerSha256: createHash('sha256').update(this._trailerBytes, 'utf8').digest('hex'),
    })
    const expected = calculateSignature(this.signingKey!, stringToSign)
    if (!signaturesMatch(expected, this._trailerSignature)) {
      throw new S3Error('SignatureDoesNotMatch', 'The trailer signature does not match')
    }
  }
}

export function encodeChunked(body: string | Buffer, {
  signed = false, seedSignature, signingKey, scope, amzDate, chunkSize = 65536, trailers = null,
}: {
  signed?: boolean
  seedSignature?: string | null
  signingKey?: Buffer | null
  scope?: string | null
  amzDate?: string | null
  chunkSize?: number
  trailers?: Record<string, string> | null
} = {}): Buffer {
  const source = Buffer.isBuffer(body) ? body : Buffer.from(body)
  const frames: Buffer[] = []
  let previousSignature = seedSignature ?? ''

  const frame = (data: Buffer): void => {
    let extension = ''
    if (signed) {
      const stringToSign = chunkStringToSign({
        amzDate: amzDate ?? null,
        scope: scope ?? null,
        previousSignature,
        chunkSha256: createHash('sha256').update(data).digest('hex'),
      })
      previousSignature = calculateSignature(signingKey!, stringToSign)
      extension = `;chunk-signature=${previousSignature}`
    }
    frames.push(Buffer.from(`${data.length.toString(16)}${extension}\r\n`), data, CRLF)
  }

  for (let offset = 0; offset < source.length; offset += chunkSize) {
    frame(source.subarray(offset, Math.min(offset + chunkSize, source.length)))
  }

  let finalExtension = ''
  if (signed) {
    const stringToSign = chunkStringToSign({
      amzDate: amzDate ?? null, scope: scope ?? null, previousSignature, chunkSha256: EMPTY_SHA256,
    })
    previousSignature = calculateSignature(signingKey!, stringToSign)
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
        amzDate: amzDate ?? null,
        scope: scope ?? null,
        previousSignature,
        trailerSha256: createHash('sha256').update(trailerBytes, 'utf8').digest('hex'),
      })
      frames.push(Buffer.from(`x-amz-trailer-signature:${calculateSignature(signingKey!, stringToSign)}\r\n`))
    }
  }

  frames.push(CRLF)
  return Buffer.concat(frames)
}
