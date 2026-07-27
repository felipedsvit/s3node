import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { Transform } from 'node:stream'
import { S3Error } from '../errors.js'

const KEY_BYTES = 32
const BLOCK_BYTES = 16
const DATA_CIPHER = 'aes-256-ctr'
const WRAP_CIPHER = 'aes-256-gcm'

/**
 * Object data is encrypted with AES-256-CTR rather than GCM because CTR is
 * seekable: a range read can jump straight to the block containing the first
 * requested byte. GCM would force decrypting from byte zero on every ranged
 * GET. Integrity still comes from the stored MD5/checksums, and the SSE-S3 data
 * key itself is wrapped with GCM.
 */

/** 128-bit big-endian counter addition, used to seek and to space parts apart. */
export function advanceIv(iv, blocks) {
  const value = (BigInt(`0x${iv.toString('hex')}`) + BigInt(blocks)) & ((1n << 128n) - 1n)
  return Buffer.from(value.toString(16).padStart(32, '0'), 'hex')
}

/**
 * Each multipart part gets its own counter window, spaced 2^64 blocks apart.
 * A part caps out at 5 GiB (2^28 blocks), so windows can never overlap and no
 * per-part IV has to be stored.
 */
export function partIv(baseIv, partNumber) {
  return partNumber ? advanceIv(baseIv, BigInt(partNumber) << 64n) : Buffer.from(baseIv)
}

/** Discards the first `count` bytes of a stream. */
class SkipBytes extends Transform {
  constructor(count) {
    super()
    this.remaining = count
  }

  _transform(chunk, _encoding, callback) {
    if (this.remaining >= chunk.length) {
      this.remaining -= chunk.length
      callback()
      return
    }
    const output = this.remaining ? chunk.subarray(this.remaining) : chunk
    this.remaining = 0
    callback(null, output)
  }
}

export class EncryptionManager {
  constructor(masterKey) {
    this.masterKey = masterKey
  }

  /**
   * Loads the SSE-S3 master key, generating and persisting one on first use.
   * Losing this file makes every SSE-S3 object unreadable.
   */
  static async load(path, provided = null) {
    if (provided) {
      const key = Buffer.isBuffer(provided) ? provided : Buffer.from(provided, 'base64')
      if (key.length !== KEY_BYTES) {
        throw new TypeError(`encryptionMasterKey must be ${KEY_BYTES} bytes`)
      }
      return new EncryptionManager(key)
    }
    try {
      const stored = Buffer.from(await readFile(path, 'utf8'), 'base64')
      if (stored.length === KEY_BYTES) return new EncryptionManager(stored)
    } catch {
      // Fall through and generate one.
    }
    const key = randomBytes(KEY_BYTES)
    await writeFile(path, key.toString('base64'), { mode: 0o600 })
    return new EncryptionManager(key)
  }

  /**
   * Reads the SSE headers off a request. Returns null when the request asks for
   * no encryption.
   */
  parseRequest(headers, { prefix = 'x-amz-server-side-encryption' } = {}) {
    const customerAlgorithm = headers[`${prefix}-customer-algorithm`]
    if (customerAlgorithm) {
      if (String(customerAlgorithm) !== 'AES256') {
        throw new S3Error('InvalidArgument', 'Unsupported customer encryption algorithm')
      }
      const rawKey = headers[`${prefix}-customer-key`]
      const declaredMd5 = headers[`${prefix}-customer-key-md5`]
      if (!rawKey || !declaredMd5) {
        throw new S3Error('InvalidRequest', 'SSE-C requires both the customer key and its MD5')
      }
      const key = Buffer.from(String(rawKey), 'base64')
      if (key.length !== KEY_BYTES) {
        throw new S3Error('InvalidArgument', 'The customer key must be 256 bits')
      }
      const keyMd5 = createHash('md5').update(key).digest('base64')
      if (keyMd5 !== String(declaredMd5)) {
        throw new S3Error('InvalidDigest', 'The customer key MD5 does not match the key')
      }
      return { mode: 'SSE-C', algorithm: 'AES256', key, keyMd5 }
    }

    const managed = headers[prefix]
    if (managed) {
      if (String(managed) !== 'AES256') {
        throw new S3Error('InvalidArgument', 'Unsupported server-side encryption algorithm')
      }
      return { mode: 'SSE-S3', algorithm: 'AES256' }
    }
    return null
  }

  /** Builds the stored encryption context and the data key used to write. */
  create(request) {
    const iv = randomBytes(BLOCK_BYTES)
    if (request.mode === 'SSE-C') {
      return {
        key: request.key,
        context: { mode: 'SSE-C', algorithm: 'AES256', iv: iv.toString('base64'), keyMd5: request.keyMd5 },
      }
    }
    const dataKey = randomBytes(KEY_BYTES)
    const wrapIv = randomBytes(12)
    const wrapper = createCipheriv(WRAP_CIPHER, this.masterKey, wrapIv)
    const wrapped = Buffer.concat([wrapper.update(dataKey), wrapper.final()])
    return {
      key: dataKey,
      context: {
        mode: 'SSE-S3',
        algorithm: 'AES256',
        iv: iv.toString('base64'),
        wrappedKey: wrapped.toString('base64'),
        wrapIv: wrapIv.toString('base64'),
        wrapTag: wrapper.getAuthTag().toString('base64'),
      },
    }
  }

  /**
   * Recovers the data key for a stored object. SSE-C objects require the client
   * to present the same key again; the server never stored it.
   */
  resolveKey(context, request) {
    if (!context) return null
    if (context.mode === 'SSE-C') {
      if (!request || request.mode !== 'SSE-C') {
        throw new S3Error('InvalidRequest',
          'The object was stored with SSE-C; the same customer key must be supplied to read it')
      }
      const stored = Buffer.from(context.keyMd5, 'base64')
      const offered = Buffer.from(request.keyMd5, 'base64')
      if (stored.length !== offered.length || !timingSafeEqual(stored, offered)) {
        throw new S3Error('AccessDenied', 'The customer key does not match the one used to store the object')
      }
      return request.key
    }
    const unwrapper = createDecipheriv(WRAP_CIPHER, this.masterKey, Buffer.from(context.wrapIv, 'base64'))
    unwrapper.setAuthTag(Buffer.from(context.wrapTag, 'base64'))
    return Buffer.concat([
      unwrapper.update(Buffer.from(context.wrappedKey, 'base64')),
      unwrapper.final(),
    ])
  }

  createEncryptStream(key, context, partNumber = 0) {
    const iv = partIv(Buffer.from(context.iv, 'base64'), partNumber)
    return createCipheriv(DATA_CIPHER, key, iv)
  }

  /**
   * Decrypts starting at `offset` bytes into the (part's) plaintext. The caller
   * must have started reading at `blockAlignedOffset(offset)`.
   */
  createDecryptStreams(key, context, offset = 0, partNumber = 0) {
    const base = partIv(Buffer.from(context.iv, 'base64'), partNumber)
    const block = Math.floor(offset / BLOCK_BYTES)
    const decipher = createDecipheriv(DATA_CIPHER, key, advanceIv(base, block))
    const skip = offset - block * BLOCK_BYTES
    return skip ? [decipher, new SkipBytes(skip)] : [decipher]
  }
}

/** Ciphertext must be read from a block boundary for CTR seeking to line up. */
export function blockAlignedOffset(offset) {
  return Math.floor(offset / BLOCK_BYTES) * BLOCK_BYTES
}

export function encryptionResponseHeaders(context) {
  if (!context) return {}
  if (context.mode === 'SSE-C') {
    return {
      'x-amz-server-side-encryption-customer-algorithm': context.algorithm,
      'x-amz-server-side-encryption-customer-key-MD5': context.keyMd5,
    }
  }
  return { 'x-amz-server-side-encryption': context.algorithm }
}
