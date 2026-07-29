import { readdir, rm, rmdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ObjectStore } from './store.js'

const BLOB_ID_RE = /^[0-9a-f]{32}$/
const GC_BATCH = 1024

export interface GCStats {
  scanned: number
  referenced: number
  orphaned: number
  deleted: number
}

/**
 * Scans the blob filesystem for orphaned blobs — files whose blobId is not
 * referenced from any metadata record — and removes them.
 *
 * Design
 * ------
 * 1. Collect every referenced blobId from the metadata store into a Set.
 * 2. Walk the blob directory tree, testing each file against the Set.
 * 3. Files not in the Set are orphaned and removed in batches.
 * 4. After removal, empty intermediate directories are cleaned up.
 *
 * The referenced Set is the dominant memory cost; for most deployments it is
 * proportionate to the number of stored objects and parts.
 */
export class GarbageCollector {
  constructor(private readonly store: ObjectStore) {}

  /**
   * Read-only scan: counts filesystem blobs, referenced blobs, and orphans
   * without deleting anything.
   */
  async scan(): Promise<GCStats> {
    const referenced = this.store.metadata.allReferencedBlobIds()
    let scanned = 0
    let orphaned = 0

    for await (const _blobId of this._walkBlobs()) {
      scanned++
      if (!referenced.has(_blobId)) orphaned++
    }

    return { scanned, referenced: referenced.size, orphaned, deleted: 0 }
  }

  /**
   * Full collect: scan + remove orphans + clean empty directories.
   * Logs a summary line via console.error to stay out of stdout pipelines.
   */
  async collect(): Promise<GCStats> {
    const referenced = this.store.metadata.allReferencedBlobIds()
    let scanned = 0
    let orphaned = 0
    let deleted = 0
    const batch: string[] = []
    const dirsTouched = new Set<string>()

    for await (const blobId of this._walkBlobs()) {
      scanned++
      if (referenced.has(blobId)) continue
      orphaned++
      batch.push(blobId)
      dirsTouched.add(blobId.slice(0, 2))
      if (batch.length >= GC_BATCH) {
        await this._removeBatch(batch)
        deleted += batch.length
        batch.length = 0
      }
    }

    if (batch.length > 0) {
      await this._removeBatch(batch)
      deleted += batch.length
    }

    await this._removeEmptyDirs(dirsTouched)

    const msg = `GC: scanned=${_fmt(scanned)} referenced=${_fmt(referenced.size)} orphaned=${_fmt(orphaned)} deleted=${_fmt(deleted)}`
    console.error(msg)

    return { scanned, referenced: referenced.size, orphaned, deleted }
  }

  /** Async generator that walks the blob directory tree. */
  private async *_walkBlobs(): AsyncGenerator<string> {
    const dataDir = this.store.blobs.dataDir
    let xxDirs: string[]
    try {
      xxDirs = await readdir(dataDir)
    } catch {
      return
    }
    for (const xx of xxDirs) {
      if (xx.length !== 2 || !/^[0-9a-f]{2}$/i.test(xx)) continue
      const xxPath = join(dataDir, xx)
      let yyDirs: string[]
      try {
        yyDirs = await readdir(xxPath)
      } catch {
        continue
      }
      for (const yy of yyDirs) {
        if (yy.length !== 2 || !/^[0-9a-f]{2}$/i.test(yy)) continue
        const yyPath = join(xxPath, yy)
        let files: string[]
        try {
          files = await readdir(yyPath)
        } catch {
          continue
        }
        for (const file of files) {
          if (BLOB_ID_RE.test(file)) yield file
        }
      }
    }
  }

  private async _removeBatch(blobIds: string[]): Promise<void> {
    await this.store.blobs.removeMany(blobIds, { concurrency: 32 })
  }

  private async _removeEmptyDirs(touched: Set<string>): Promise<void> {
    const dataDir = this.store.blobs.dataDir
    for (const xx of touched) {
      const xxPath = join(dataDir, xx)
      let yyDirs: string[]
      try {
        yyDirs = await readdir(xxPath)
      } catch {
        continue
      }
      for (const yy of yyDirs) {
        if (yy.length !== 2 || !/^[0-9a-f]{2}$/i.test(yy)) continue
        const yyPath = join(xxPath, yy)
        try {
          const remaining = await readdir(yyPath)
          if (remaining.length === 0) {
            await rmdir(yyPath)
          }
        } catch { /* skip if already removed or inaccessible */ }
      }
      try {
        const remaining = await readdir(xxPath)
        if (remaining.length === 0) {
          await rmdir(xxPath)
        }
      } catch { /* skip */ }
    }
  }
}

function _fmt(n: number): string {
  return n.toLocaleString('en-US')
}
