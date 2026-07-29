import type { ObjectStore } from './store.js'

export interface CleanupStats {
  scanned: number
  aborted: number
  partsRemoved: number
}

/**
 * Aborts stale multipart uploads whose initiation time exceeds a configurable
 * threshold. Uses the same internal abort path as the S3 API: removes part
 * blobs, then deletes upload metadata within the same transaction.
 *
 * Configuration
 * -------------
 * `expirationHours` (default 24) — uploads older than this are aborted.
 *
 * Safety
 * ------
 * Errors during one upload's abort never interrupt the sweep. The error is
 * logged (console.error) and processing continues with the next upload.
 */
export class MultipartCleanup {
  constructor(private readonly store: ObjectStore) {}

  async cleanup(expirationHours = 24): Promise<CleanupStats> {
    const cutoff = Date.now() - expirationHours * 3_600_000
    const uploads = this.store.metadata.allStaleUploads(cutoff)
    const stats: CleanupStats = { scanned: uploads.length, aborted: 0, partsRemoved: 0 }

    for (const upload of uploads) {
      const key = upload.key.toString('utf8')
      try {
        const parts = this.store.metadata.allParts(upload.uploadId)
        stats.partsRemoved += parts.length
        await this.store.abortMultipartUpload({
          bucket: upload.bucket,
          key,
          uploadId: upload.uploadId,
        })
        stats.aborted++
      } catch (err) {
        console.error(
          `multipartCleanup: failed to abort upload ${upload.uploadId} ` +
          `(bucket=${upload.bucket} key=${key}): ${(err as Error).message}`,
        )
      }
    }

    if (stats.aborted > 0) {
      const msg = `multipartCleanup: scanned=${stats.scanned} aborted=${stats.aborted} parts=${stats.partsRemoved}`
      console.error(msg)
    }

    return stats
  }
}
