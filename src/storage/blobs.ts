import { randomUUID } from 'node:crypto'
import { closeSync, createReadStream, createWriteStream, openSync } from 'node:fs'
import { mkdir, open, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { HashingStream } from '../util/hash.js'
import { MaxSizeStream } from '../util/bytes.js'
import { faultPoint } from '../faults.js'
import { sliceParts, type BlobPart } from './parts.js'

export const READ_HIGH_WATER_MARK = 1024 * 1024
export const BLOB_RETIRE_GRACE_MS = 30_000

async function fsyncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(directory, 'r')
    await handle.sync()
  } catch {
    // Directory fsync is unavailable on some platforms
  } finally {
    await handle?.close().catch(() => {})
  }
}

export interface WriteResult {
  blobId: string
  size: number
  hasher: HashingStream
}

export interface BlobWriteOptions {
  algorithms?: string[]
  transforms?: NodeJS.ReadWriteStream[]
  maxSize?: number
  blobId?: string
}

export function newBlobId(): string {
  return randomUUID().replaceAll('-', '')
}

export type { BlobPart }

export class BlobStore {
  root: string
  dataDir: string
  tmpDir: string
  retiredDir: string
  private readonly retirementTimers = new Map<string, NodeJS.Timeout>()

  constructor(root: string) {
    this.root = root
    this.dataDir = join(root, 'data')
    this.tmpDir = join(root, 'tmp')
    this.retiredDir = join(root, 'retired')
  }

  async init(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true })
    await mkdir(this.tmpDir, { recursive: true })
    await mkdir(this.retiredDir, { recursive: true })
  }

  path(blobId: string): string {
    return join(this.dataDir, blobId.slice(0, 2), blobId.slice(2, 4), blobId)
  }

  async write(source: NodeJS.ReadableStream | NodeJS.ReadableStream[], {
    algorithms = ['md5'], transforms = [], maxSize = 0, blobId = newBlobId(),
  }: BlobWriteOptions = {}): Promise<WriteResult> {
    const finalPath = this.path(blobId)
    const tmpPath = join(dirname(finalPath), `.${blobId}.tmp-${Date.now()}`)
    const hasher = new HashingStream(algorithms)
    const chain = Array.isArray(source) ? source : [source]
    const sizeGuard = maxSize > 0 ? [new MaxSizeStream(maxSize)] : []

    try {
      await mkdir(dirname(finalPath), { recursive: true })
      await (pipeline as (...args: unknown[]) => Promise<void>)(
        ...chain as NodeJS.ReadableStream[], hasher, ...transforms as NodeJS.ReadWriteStream[], ...sizeGuard,
        createWriteStream(tmpPath, { flags: 'wx', mode: 0o600 }))

      const handle = await open(tmpPath, 'r+')
      try {
        await handle.sync()
      } finally {
        await handle.close()
      }
      faultPoint('blob:after-file-fsync')

      try {
        await rename(tmpPath, finalPath)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
          const src = await open(tmpPath, 'r')
          try {
            const dst = createWriteStream(finalPath, { flags: 'wx', mode: 0o600 })
            await pipeline(src.createReadStream(), dst)
            const finalHandle = await open(finalPath, 'r+')
            try {
              await finalHandle.sync()
            } finally {
              await finalHandle.close()
            }
          } finally {
            await src.close()
          }
          await rm(tmpPath, { force: true })
        } else {
          throw err
        }
      }
      await fsyncDirectory(dirname(finalPath))
      faultPoint('blob:after-publish')

      return { blobId, size: hasher.bytesWritten, hasher }
    } catch (err) {
      await rm(tmpPath, { force: true }).catch(() => {})
      throw err
    }
  }

  async remove(blobId: string | null | undefined): Promise<void> {
    if (!blobId) return
    const timer = this.retirementTimers.get(blobId)
    if (timer) clearTimeout(timer)
    this.retirementTimers.delete(blobId)
    await rm(this.path(blobId), { force: true })
    await rm(this.retirementPath(blobId), { force: true })
  }

  async removeMany(blobIds: (string | null | undefined)[], { concurrency = 32 } = {}): Promise<void> {
    const unique = [...new Set(blobIds.filter((id): id is string => id != null))]
    for (let i = 0; i < unique.length; i += concurrency) {
      await Promise.all(unique.slice(i, i + concurrency).map((id) => this.remove(id)))
    }
  }

  /**
   * Defers physical removal long enough for a request that already resolved
   * metadata to open its file descriptors. The marker makes the grace period
   * visible to a garbage collector running in another cluster worker.
   */
  async retireMany(blobIds: (string | null | undefined)[]): Promise<void> {
    const unique = [...new Set(blobIds.filter((id): id is string => id != null))]
    await Promise.all(unique.map(async (blobId) => {
      await writeFile(this.retirementPath(blobId), String(Date.now()), { mode: 0o600 })
      const previous = this.retirementTimers.get(blobId)
      if (previous) clearTimeout(previous)
      const timer = setTimeout(() => {
        this.retirementTimers.delete(blobId)
        void this.remove(blobId).catch((err: Error) => {
          console.error(`failed to remove retired blob ${blobId}: ${err.message}`)
        })
      }, BLOB_RETIRE_GRACE_MS)
      timer.unref?.()
      this.retirementTimers.set(blobId, timer)
    }))
  }

  async isWithinRetirementGrace(blobId: string, now = Date.now()): Promise<boolean> {
    try {
      const marker = await stat(this.retirementPath(blobId))
      return now - marker.mtimeMs < BLOB_RETIRE_GRACE_MS
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw err
    }
  }

  private retirementPath(blobId: string): string {
    return join(this.retiredDir, blobId)
  }

  async size(blobId: string): Promise<number> {
    return (await stat(this.path(blobId))).size
  }

  createReadStream(blobId: string, { start, end }: { start?: number; end?: number } = {}): ReturnType<typeof createReadStream> {
    const path = this.path(blobId)
    const fd = openSync(path, 'r')
    try {
      return createReadStream(path, {
        fd,
        autoClose: true,
        start,
        end,
        highWaterMark: READ_HIGH_WATER_MARK,
      })
    } catch (err) {
      closeSync(fd)
      throw err
    }
  }

  createRangeStream(parts: BlobPart[], start: number, end: number): Readable {
    const streams: ReturnType<typeof createReadStream>[] = []
    try {
      for (const slice of sliceParts(parts, start, end)) {
        streams.push(this.createReadStream(slice.blobId, { start: slice.from, end: slice.to }))
      }
    } catch (err) {
      for (const stream of streams) stream.destroy()
      throw err
    }
    async function* generate(): AsyncGenerator<Buffer> {
      try {
        for (const stream of streams) yield* stream
      } finally {
        for (const stream of streams) stream.destroy()
      }
    }
    return Readable.from(generate(), { highWaterMark: READ_HIGH_WATER_MARK })
  }
}
