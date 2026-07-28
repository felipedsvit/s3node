import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { Transform, type TransformCallback } from 'node:stream'
import { S3Error } from '../errors.js'

const KEY_BYTES = 32
const BLOCK_BYTES = 16
const DATA_CIPHER = 'aes-256-ctr'
const WRAP_CIPHER = 'aes-256-gcm'

export function advanceIv(iv: Buffer, blocks: bigint | number): Buffer {
  const value = (BigInt(`0x${iv.toString('hex')}`) + BigInt(blocks)) & ((1n << 128n) - 1n)
  return Buffer.from(value.toString(16).padStart(32, '0'), 'hex')
}

export function partIv(baseIv: Buffer, partNumber: number): Buffer {
  return partNumber ? advanceIv(baseIv, BigInt(partNumber) << 64n) : Buffer.from(baseIv)
}

class SkipBytes extends Transform {
  remaining: number

  constructor(count: number) {
    super()
    this.remaining = count
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
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

export interface SseRequest {
  mode: 'SSE-C' | 'SSE-S3'
  algorithm: string
  key?: Buffer
  keyMd5?: string
}

export interface EncryptionContext {
  mode: string
  algorithm: string
  iv: string
  keyMd5?: string
  wrappedKey?: string
  wrapIv?: string
  wrapTag?: string
}

export interface CreatedEncryption {
  key: Buffer
  context: EncryptionContext
}

export class EncryptionManager {
  masterKey: Buffer

  constructor(masterKey: Buffer) {
    this.masterKey = masterKey
  }

  static async load(path: string, provided: string | Buffer | null = null): Promise<EncryptionManager> {
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

  parseRequest(headers: Record<string, string | string[] | undefined>, { prefix = 'x-amz-server-side-encryption' } = {}): SseRequest | null {
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

  create(request: SseRequest): CreatedEncryption {
    const iv = randomBytes(BLOCK_BYTES)
    if (request.mode === 'SSE-C') {
      return {
        key: request.key!,
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

  resolveKey(context: EncryptionContext | null | undefined, request: SseRequest | null | undefined): Buffer | null {
    if (!context) return null
    if (context.mode === 'SSE-C') {
      if (!request || request.mode !== 'SSE-C') {
        throw new S3Error('InvalidRequest',
          'The object was stored with SSE-C; the same customer key must be supplied to read it')
      }
      const stored = Buffer.from(context.keyMd5!, 'base64')
      const offered = Buffer.from(request.keyMd5!, 'base64')
      if (stored.length !== offered.length || !timingSafeEqual(stored, offered)) {
        throw new S3Error('AccessDenied', 'The customer key does not match the one used to store the object')
      }
      return request.key ?? null
    }
    const unwrapper = createDecipheriv(WRAP_CIPHER, this.masterKey, Buffer.from(context.wrapIv!, 'base64'))
    unwrapper.setAuthTag(Buffer.from(context.wrapTag!, 'base64'))
    return Buffer.concat([
      unwrapper.update(Buffer.from(context.wrappedKey!, 'base64')),
      unwrapper.final(),
    ])
  }

  createEncryptStream(key: Buffer, context: EncryptionContext, partNumber = 0): ReturnType<typeof createCipheriv> {
    const iv = partIv(Buffer.from(context.iv, 'base64'), partNumber)
    return createCipheriv(DATA_CIPHER, key, iv)
  }

  createDecryptStreams(key: Buffer, context: EncryptionContext, offset = 0, partNumber = 0): (ReturnType<typeof createDecipheriv> | SkipBytes)[] {
    const base = partIv(Buffer.from(context.iv, 'base64'), partNumber)
    const block = Math.floor(offset / BLOCK_BYTES)
    const decipher = createDecipheriv(DATA_CIPHER, key, advanceIv(base, block))
    const skip = offset - block * BLOCK_BYTES
    return skip ? [decipher, new SkipBytes(skip)] : [decipher]
  }
}

export function blockAlignedOffset(offset: number): number {
  return Math.floor(offset / BLOCK_BYTES) * BLOCK_BYTES
}

export function encryptionResponseHeaders(context: EncryptionContext | null | undefined): Record<string, string> {
  if (!context) return {}
  if (context.mode === 'SSE-C') {
    return {
      'x-amz-server-side-encryption-customer-algorithm': context.algorithm,
      'x-amz-server-side-encryption-customer-key-MD5': context.keyMd5!,
    }
  }
  return { 'x-amz-server-side-encryption': context.algorithm }
}
