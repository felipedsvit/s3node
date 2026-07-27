import { randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { HashingStream } from '../util/hash.js'

const READ_HIGH_WATER_MARK = 1024 * 1024

async function fsyncDirectory(directory) {
  let handle
  try {
    handle = await open(directory, 'r')
    await handle.sync()
  } catch {
    // Directory fsync is unavailable on some platforms (notably Windows).
  } finally {
    await handle?.close().catch(() => {})
  }
}

/**
 * Content-addressed blob storage.
 *
 * Blob names are decoupled from object keys. That is what makes `../` in a key
 * harmless: a key never becomes a filesystem path, so the entire path-traversal
 * class is eliminated by construction (docs/plan.md section 7).
 */
export class BlobStore {
  constructor(root) {
    this.root = root
    this.dataDir = join(root, 'data')
    this.tmpDir = join(root, 'tmp')
  }

  async init() {
    await mkdir(this.dataDir, { recursive: true })
    await mkdir(this.tmpDir, { recursive: true })
  }

  /** Two-level fanout keeps directory sizes bounded. */
  path(blobId) {
    return join(this.dataDir, blobId.slice(0, 2), blobId.slice(2, 4), blobId)
  }

  /**
   * Durable write. The step order matters and is load-bearing: the blob is
   * fully persisted before any metadata references it. A crash mid-sequence
   * leaves an orphan blob (swept later); the reverse order would leave metadata
   * pointing at a missing blob, which is observable data loss.
   */
  async write(source, { algorithms = ['md5'], transforms = [] } = {}) {
    const blobId = randomUUID().replaceAll('-', '')
    const tmpPath = join(this.tmpDir, blobId)
    const hasher = new HashingStream(algorithms)
    // `source` may be a chain (request -> chunked decoder); pipeline propagates
    // errors and destroys every stage, which a bare .pipe() would not.
    const chain = Array.isArray(source) ? source : [source]

    try {
      // 1-2. Stream to a temp file on the same filesystem, hashing in one pass.
      //      Digests are taken over the plaintext, so any encryption transform
      //      sits after the hasher — the ETag stays the MD5 clients expect.
      await pipeline(...chain, hasher, ...transforms,
        createWriteStream(tmpPath, { flags: 'wx', mode: 0o600 }))

      // 3. fsync the file itself.
      const handle = await open(tmpPath, 'r+')
      try {
        await handle.sync()
      } finally {
        await handle.close()
      }

      // 4-5. Atomically move into place, then fsync the parent directory so the
      //      rename survives power loss.
      const finalPath = this.path(blobId)
      await mkdir(dirname(finalPath), { recursive: true })
      await rename(tmpPath, finalPath)
      await fsyncDirectory(dirname(finalPath))

      return { blobId, size: hasher.bytesWritten, hasher }
    } catch (err) {
      await rm(tmpPath, { force: true }).catch(() => {})
      throw err
    }
  }

  async remove(blobId) {
    if (!blobId) return
    await rm(this.path(blobId), { force: true }).catch(() => {})
  }

  async removeMany(blobIds) {
    await Promise.all([...new Set(blobIds)].map((id) => this.remove(id)))
  }

  async size(blobId) {
    return (await stat(this.path(blobId))).size
  }

  createReadStream(blobId, { start, end } = {}) {
    return createReadStream(this.path(blobId), {
      start,
      end,
      highWaterMark: READ_HIGH_WATER_MARK,
    })
  }

  /**
   * Virtual concatenation across a multipart manifest. Parts stay as separate
   * blobs — `CompleteMultipartUpload` writes a manifest instead of rewriting
   * the object, which keeps Complete cheap and range reads efficient
   * (docs/plan.md section 8).
   */
  createRangeStream(parts, start, end) {
    const store = this
    async function* generate() {
      let offset = 0
      for (const part of parts) {
        const partStart = offset
        const partEnd = offset + part.size - 1
        offset += part.size
        if (partEnd < start) continue
        if (partStart > end) break
        const from = Math.max(start - partStart, 0)
        const to = Math.min(end - partStart, part.size - 1)
        if (to < from) continue
        yield* store.createReadStream(part.blobId, { start: from, end: to })
      }
    }
    return Readable.from(generate(), { highWaterMark: READ_HIGH_WATER_MARK })
  }
}
