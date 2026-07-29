import { randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { HashingStream } from '../util/hash.js'
import { MaxSizeStream } from '../util/bytes.js'
import { sliceParts, type BlobPart } from './parts.js'

export const READ_HIGH_WATER_MARK = 1024 * 1024

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

export type { BlobPart }

export class BlobStore {
  root: string
  dataDir: string
  tmpDir: string

  constructor(root: string) {
    this.root = root
    this.dataDir = join(root, 'data')
    this.tmpDir = join(root, 'tmp')
  }

  async init(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true })
    await mkdir(this.tmpDir, { recursive: true })
  }

  path(blobId: string): string {
    return join(this.dataDir, blobId.slice(0, 2), blobId.slice(2, 4), blobId)
  }

  async write(source: NodeJS.ReadableStream | NodeJS.ReadableStream[], { algorithms = ['md5'], transforms = [] as NodeJS.ReadWriteStream[], maxSize = 0 } = {}): Promise<WriteResult> {
    const blobId = randomUUID().replaceAll('-', '')
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

      return { blobId, size: hasher.bytesWritten, hasher }
    } catch (err) {
      await rm(tmpPath, { force: true }).catch(() => {})
      throw err
    }
  }

  async remove(blobId: string | null | undefined): Promise<void> {
    if (!blobId) return
    await rm(this.path(blobId), { force: true }).catch(() => {})
  }

  async removeMany(blobIds: (string | null | undefined)[], { concurrency = 32 } = {}): Promise<void> {
    const unique = [...new Set(blobIds.filter((id): id is string => id != null))]
    for (let i = 0; i < unique.length; i += concurrency) {
      await Promise.all(unique.slice(i, i + concurrency).map((id) => this.remove(id)))
    }
  }

  async size(blobId: string): Promise<number> {
    return (await stat(this.path(blobId))).size
  }

  createReadStream(blobId: string, { start, end }: { start?: number; end?: number } = {}): ReturnType<typeof createReadStream> {
    return createReadStream(this.path(blobId), {
      start,
      end,
      highWaterMark: READ_HIGH_WATER_MARK,
    })
  }

  createRangeStream(parts: BlobPart[], start: number, end: number): Readable {
    const store = this
    async function* generate(): AsyncGenerator<Buffer> {
      for (const slice of sliceParts(parts, start, end)) {
        yield* store.createReadStream(slice.blobId, { start: slice.from, end: slice.to })
      }
    }
    return Readable.from(generate(), { highWaterMark: READ_HIGH_WATER_MARK })
  }
}
