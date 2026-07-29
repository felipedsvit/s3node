/**
 * Fixed-size buffer pool: `rent()` reuses a previously-released buffer or
 * allocates a new one (uninitialized — callers must fill it before reading),
 * `release()` returns it for reuse up to `count` buffers.
 *
 * Not wired into the multipart/putObject write path: that path streams
 * straight from source to `fs.createWriteStream` (`src/storage/blobs.ts`)
 * without ever copying a chunk into an application-owned buffer, so there is
 * no repeated allocation there for a pool to amortize. This is a standalone
 * utility for call sites that do need a reusable fixed-size scratch buffer.
 */
export class BufferPool {
  private readonly pool: Buffer[] = []

  constructor(private readonly size: number, private readonly count: number) {
    if (!Number.isInteger(size) || size <= 0) throw new RangeError('size must be a positive integer')
    if (!Number.isInteger(count) || count < 0) throw new RangeError('count must be a non-negative integer')
  }

  rent(): Buffer {
    return this.pool.pop() ?? Buffer.allocUnsafe(this.size)
  }

  release(buf: Buffer): void {
    if (buf.length === this.size && this.pool.length < this.count) this.pool.push(buf)
  }

  /** Rents a buffer for the duration of `fn`, releasing it even if `fn` throws. */
  async use<T>(fn: (buf: Buffer) => Promise<T> | T): Promise<T> {
    const buf = this.rent()
    try {
      return await fn(buf)
    } finally {
      this.release(buf)
    }
  }

  get pooled(): number { return this.pool.length }
}
