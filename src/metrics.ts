/**
 * Minimal Prometheus text-exposition-format metrics — no `prom-client`, this
 * project ships zero runtime dependencies (see package.json).
 * https://github.com/prometheus/docs/blob/main/content/docs/instrumenting/exposition_formats.md
 */

import { stat, statfs } from 'node:fs/promises'
import type { ObjectStore } from './storage/store.js'
import type { GCStats } from './storage/gc.js'

type Labels = Record<string, string>

function labelKey(labels: Labels): string {
  const names = Object.keys(labels).sort()
  return names.map((name) => `${name}=${JSON.stringify(labels[name])}`).join(',')
}

function renderLabels(key: string): string {
  if (!key) return ''
  const pairs = key.split(',').map((pair) => {
    const eq = pair.indexOf('=')
    const name = pair.slice(0, eq)
    const value = (JSON.parse(pair.slice(eq + 1)) as string).replace(/[\\"\n]/g, (c) => (c === '\n' ? '\\n' : `\\${c}`))
    return `${name}="${value}"`
  })
  return `{${pairs.join(',')}}`
}

class Counter {
  private readonly values = new Map<string, number>()

  constructor(private readonly name: string, private readonly help: string) {}

  inc(labels: Labels = {}, value = 1): void {
    const key = labelKey(labels)
    this.values.set(key, (this.values.get(key) ?? 0) + value)
  }

  render(): string {
    if (this.values.size === 0) return ''
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`]
    for (const [key, value] of this.values) lines.push(`${this.name}${renderLabels(key)} ${value}`)
    return lines.join('\n')
  }
}

class Gauge {
  private readonly values = new Map<string, number>()

  constructor(private readonly name: string, private readonly help: string) {}

  set(labels: Labels, value: number): void {
    this.values.set(labelKey(labels), value)
  }

  inc(labels: Labels = {}, value = 1): void {
    const key = labelKey(labels)
    this.values.set(key, (this.values.get(key) ?? 0) + value)
  }

  dec(labels: Labels = {}, value = 1): void {
    this.inc(labels, -value)
  }

  render(): string {
    if (this.values.size === 0) return ''
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`]
    for (const [key, value] of this.values) lines.push(`${this.name}${renderLabels(key)} ${value}`)
    return lines.join('\n')
  }
}

const DEFAULT_BUCKETS_SECONDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]

class Histogram {
  private readonly buckets: Map<string, number[]> = new Map()
  private readonly sums = new Map<string, number>()
  private readonly counts = new Map<string, number>()

  constructor(private readonly name: string, private readonly help: string, private readonly bucketBounds = DEFAULT_BUCKETS_SECONDS) {}

  observe(labels: Labels, value: number): void {
    const key = labelKey(labels)
    if (!this.buckets.has(key)) this.buckets.set(key, new Array(this.bucketBounds.length).fill(0))
    const counts = this.buckets.get(key)!
    for (let i = 0; i < this.bucketBounds.length; i++) {
      if (value <= this.bucketBounds[i]) { counts[i]++; break }
    }
    this.sums.set(key, (this.sums.get(key) ?? 0) + value)
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1)
  }

  render(): string {
    if (this.buckets.size === 0) return ''
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`]
    for (const [key, counts] of this.buckets) {
      const labels = key ? key.split(',') : []
      let cumulative = 0
      for (let i = 0; i < this.bucketBounds.length; i++) {
        cumulative += counts[i]
        const withLe = [...labels, `le=${JSON.stringify(String(this.bucketBounds[i]))}`].join(',')
        lines.push(`${this.name}_bucket${renderLabels(withLe)} ${cumulative}`)
      }
      const withInfLe = [...labels, `le=${JSON.stringify('+Inf')}`].join(',')
      lines.push(`${this.name}_bucket${renderLabels(withInfLe)} ${this.counts.get(key)}`)
      lines.push(`${this.name}_sum${renderLabels(key)} ${this.sums.get(key)}`)
      lines.push(`${this.name}_count${renderLabels(key)} ${this.counts.get(key)}`)
    }
    return lines.join('\n')
  }
}

/** In-process metrics for one server instance. Cheap to instantiate; not shared across processes/workers. */
export class MetricsRegistry {
  readonly httpRequestsTotal = new Counter('s3node_http_requests_total', 'Total HTTP requests handled')
  readonly httpErrorsTotal = new Counter('s3node_http_errors_total', 'Total HTTP requests that ended in an error')
  readonly httpRequestDurationSeconds = new Histogram('s3node_http_request_duration_seconds', 'HTTP request duration in seconds')
  readonly bytesInTotal = new Counter('s3node_bytes_in_total', 'Total request body bytes received')
  readonly bytesOutTotal = new Counter('s3node_bytes_out_total', 'Total response body bytes sent')
  readonly activeMultipartUploads = new Gauge('s3node_active_multipart_uploads', 'In-progress multipart uploads')
  readonly notificationQueueMessages = new Gauge('s3node_notification_queue_messages', 'Persistent notification queue messages by status')
  readonly sqliteWalBytes = new Gauge('s3node_sqlite_wal_bytes', 'Current SQLite WAL file size in bytes')
  readonly storageFreeBytes = new Gauge('s3node_storage_free_bytes', 'Free bytes available on the data directory filesystem')
  readonly storageTotalBytes = new Gauge('s3node_storage_total_bytes', 'Total bytes on the data directory filesystem')
  readonly processStartTimeSeconds = new Gauge('s3node_process_start_time_seconds', 'Unix time when this server process started')
  readonly serverStartsTotal = new Counter('s3node_server_starts_total', 'Server instances started in this process')
  readonly gcRunsTotal = new Counter('s3node_gc_runs_total', 'Garbage collection runs by result')
  readonly gcDurationSeconds = new Histogram('s3node_gc_duration_seconds', 'Garbage collection duration in seconds')
  readonly gcLastScannedBlobs = new Gauge('s3node_gc_last_scanned_blobs', 'Blobs scanned by the latest successful garbage collection')
  readonly gcLastOrphanedBlobs = new Gauge('s3node_gc_last_orphaned_blobs', 'Orphaned blobs found by the latest successful garbage collection')
  readonly gcLastDeletedBlobs = new Gauge('s3node_gc_last_deleted_blobs', 'Blobs deleted by the latest successful garbage collection')
  readonly gcLastSuccessTimestampSeconds = new Gauge('s3node_gc_last_success_timestamp_seconds', 'Unix time of the latest successful garbage collection')

  markServerStart(): void {
    this.processStartTimeSeconds.set({}, Math.floor(Date.now() / 1000 - process.uptime()))
    this.serverStartsTotal.inc()
  }

  recordGarbageCollection(stats: GCStats, durationSeconds: number): void {
    this.gcRunsTotal.inc({ result: 'success' })
    this.gcDurationSeconds.observe({}, durationSeconds)
    this.gcLastScannedBlobs.set({}, stats.scanned)
    this.gcLastOrphanedBlobs.set({}, stats.orphaned)
    this.gcLastDeletedBlobs.set({}, stats.deleted)
    this.gcLastSuccessTimestampSeconds.set({}, Math.floor(Date.now() / 1000))
  }

  recordGarbageCollectionFailure(durationSeconds: number): void {
    this.gcRunsTotal.inc({ result: 'error' })
    this.gcDurationSeconds.observe({}, durationSeconds)
  }

  async collectOperational(store: ObjectStore): Promise<void> {
    const buckets = store.listBuckets()
    const activeUploads = buckets.reduce((total, bucket) => total + store.metadata.uploadCount(bucket.name), 0)
    this.activeMultipartUploads.set({}, activeUploads)
    for (const [status, count] of Object.entries(store.metadata.notificationQueueCounts())) {
      this.notificationQueueMessages.set({ status }, count)
    }

    let walBytes = 0
    if (store.metadata.path !== ':memory:') {
      try { walBytes = (await stat(`${store.metadata.path}-wal`)).size } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      }
    }
    this.sqliteWalBytes.set({}, walBytes)

    const filesystem = await statfs(store.blobs.root)
    this.storageFreeBytes.set({}, filesystem.bavail * filesystem.bsize)
    this.storageTotalBytes.set({}, filesystem.blocks * filesystem.bsize)
  }

  renderPrometheus(): string {
    const sections = [
      this.httpRequestsTotal.render(),
      this.httpErrorsTotal.render(),
      this.httpRequestDurationSeconds.render(),
      this.bytesInTotal.render(),
      this.bytesOutTotal.render(),
      this.activeMultipartUploads.render(),
      this.notificationQueueMessages.render(),
      this.sqliteWalBytes.render(),
      this.storageFreeBytes.render(),
      this.storageTotalBytes.render(),
      this.processStartTimeSeconds.render(),
      this.serverStartsTotal.render(),
      this.gcRunsTotal.render(),
      this.gcDurationSeconds.render(),
      this.gcLastScannedBlobs.render(),
      this.gcLastOrphanedBlobs.render(),
      this.gcLastDeletedBlobs.render(),
      this.gcLastSuccessTimestampSeconds.render(),
    ].filter(Boolean)
    return sections.join('\n') + '\n'
  }
}
