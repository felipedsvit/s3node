import { createHash, type Hash } from 'node:crypto'
import { Transform, type TransformCallback } from 'node:stream'
import { Crc32, Crc32c } from './crc.js'

export const CHECKSUM_ALGORITHMS = ['crc32', 'crc32c', 'sha1', 'sha256']

type Digester = Hash | Crc32 | Crc32c

function createDigester(algorithm: string): Digester {
  if (algorithm === 'crc32') return new Crc32()
  if (algorithm === 'crc32c') return new Crc32c()
  return createHash(algorithm)
}

export class HashingStream extends Transform {
  algorithms: string[]
  digesters: Map<string, Digester>
  bytesWritten: number
  _digests: Map<string, Buffer | string>

  constructor(algorithms: string[] = ['md5'], options = {}) {
    super(options)
    this.algorithms = [...new Set(algorithms)]
    this.digesters = new Map(this.algorithms.map((a) => [a, createDigester(a)]))
    this.bytesWritten = 0
    this._digests = new Map()
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.bytesWritten += chunk.length
    for (const digester of this.digesters.values()) digester.update(chunk)
    callback(null, chunk)
  }

  digest(algorithm: string, encoding: BufferEncoding | 'buffer' = 'hex'): string {
    const cacheKey = `${algorithm}:${encoding}`
    if (this._digests.has(cacheKey)) return this._digests.get(cacheKey) as string
    const digester = this.digesters.get(algorithm)
    if (!digester) throw new Error(`Digest not computed: ${algorithm}`)
    const raw = (this._digests.get(`${algorithm}:buffer`) as Buffer) ?? digester.digest()
    this._digests.set(`${algorithm}:buffer`, raw)
    const value = encoding === 'buffer' ? raw : raw.toString(encoding)
    this._digests.set(cacheKey, value)
    return value as string
  }
}

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

export function md5Hex(data: Buffer | string): string {
  return createHash('md5').update(data).digest('hex')
}

export function multipartEtag(partMd5Hexes: string[]): string {
  const concatenated = Buffer.concat(partMd5Hexes.map((hex) => Buffer.from(hex, 'hex')))
  return `${createHash('md5').update(concatenated).digest('hex')}-${partMd5Hexes.length}`
}
