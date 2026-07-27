import { createHash } from 'node:crypto'
import { Transform } from 'node:stream'
import { Crc32, Crc32c } from './crc.js'

/** Checksum algorithm names as they appear in `x-amz-checksum-*` headers. */
export const CHECKSUM_ALGORITHMS = ['crc32', 'crc32c', 'sha1', 'sha256']

function createDigester(algorithm) {
  if (algorithm === 'crc32') return new Crc32()
  if (algorithm === 'crc32c') return new Crc32c()
  return createHash(algorithm)
}

/**
 * Pass-through stream that computes every requested digest in a single pass.
 * Only the digests a request actually needs should be asked for: hashing runs
 * on the main thread and is the dominant CPU cost of the write path
 * (docs/plan.md section 6.2).
 */
export class HashingStream extends Transform {
  constructor(algorithms = ['md5'], options = {}) {
    super(options)
    this.algorithms = [...new Set(algorithms)]
    this.digesters = new Map(this.algorithms.map((a) => [a, createDigester(a)]))
    this.bytesWritten = 0
    this._digests = new Map()
  }

  _transform(chunk, _encoding, callback) {
    this.bytesWritten += chunk.length
    for (const digester of this.digesters.values()) digester.update(chunk)
    callback(null, chunk)
  }

  /** Digest of a single algorithm. Safe to call repeatedly. */
  digest(algorithm, encoding = 'hex') {
    const cacheKey = `${algorithm}:${encoding}`
    if (this._digests.has(cacheKey)) return this._digests.get(cacheKey)
    const digester = this.digesters.get(algorithm)
    if (!digester) throw new Error(`Digest not computed: ${algorithm}`)
    const raw = this._digests.get(`${algorithm}:buffer`) ?? digester.digest()
    this._digests.set(`${algorithm}:buffer`, raw)
    const value = encoding === 'buffer' ? raw : raw.toString(encoding)
    this._digests.set(cacheKey, value)
    return value
  }
}

export function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex')
}

export function md5Hex(data) {
  return createHash('md5').update(data).digest('hex')
}

/**
 * Multipart ETag: MD5 over the concatenated *binary* MD5 digests of every
 * part, suffixed with the part count (docs/plan.md section 4.3).
 */
export function multipartEtag(partMd5Hexes) {
  const concatenated = Buffer.concat(partMd5Hexes.map((hex) => Buffer.from(hex, 'hex')))
  return `${createHash('md5').update(concatenated).digest('hex')}-${partMd5Hexes.length}`
}
