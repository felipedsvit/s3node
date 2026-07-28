import { Transform, type TransformCallback } from 'node:stream'
import { S3Error } from '../errors.js'

export class MaxSizeStream extends Transform {
  maxBytes: number
  written: number

  constructor(maxBytes: number) {
    super()
    this.maxBytes = maxBytes
    this.written = 0
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.written += chunk.length
    if (this.written > this.maxBytes) {
      callback(new S3Error('EntityTooLarge'))
      return
    }
    callback(null, chunk)
  }
}

export function toKeyBuffer(key: Buffer | string): Buffer {
  return Buffer.isBuffer(key) ? key : Buffer.from(String(key), 'utf8')
}

export function compareKeys(a: Buffer | string, b: Buffer | string): number {
  return Buffer.compare(toKeyBuffer(a), toKeyBuffer(b))
}

export function prefixUpperBound(prefix: Buffer | string): Buffer | null {
  const buf = toKeyBuffer(prefix)
  for (let i = buf.length - 1; i >= 0; i--) {
    if (buf[i] < 0xff) {
      const bound = Buffer.from(buf.subarray(0, i + 1))
      bound[i] += 1
      return bound
    }
  }
  return null
}

export function keySuccessor(key: Buffer | string): Buffer {
  return Buffer.concat([toKeyBuffer(key), Buffer.from([0x00])])
}
