import { S3Error } from '../errors.js'
import type { NotificationQueueRow } from '../storage/metadata.js'
import { childNamed, childText, childrenNamed, document, parseXml, text } from '../xml.js'

const DISPATCH_TIMEOUT_MS = 5000

const KNOWN_EVENTS = [
  's3:ObjectCreated:*',
  's3:ObjectCreated:Put',
  's3:ObjectCreated:Post',
  's3:ObjectCreated:Copy',
  's3:ObjectCreated:CompleteMultipartUpload',
  's3:ObjectRemoved:*',
  's3:ObjectRemoved:Delete',
  's3:ObjectRemoved:DeleteMarkerCreated',
]

interface NotificationFilter {
  prefix?: string
  suffix?: string
}

interface NotificationTarget {
  id: string
  endpoint: string
  events: string[]
  filter: NotificationFilter
}

export interface NotificationConfig {
  targets: NotificationTarget[]
}

function parseFilter(node: ReturnType<typeof parseXml>): NotificationFilter {
  const filter = childNamed(node, 'Filter')
  const s3Key = filter ? childNamed(filter, 'S3Key') : null
  const rules: NotificationFilter = {}
  for (const rule of childrenNamed(s3Key, 'FilterRule')) {
    const name = childText(rule, 'Name')?.toLowerCase()
    if (name === 'prefix' || name === 'suffix') rules[name] = childText(rule, 'Value') ?? ''
  }
  return rules
}

export function parseNotificationXml(body: string | Buffer): NotificationConfig {
  const root = parseXml(body)
  if (root.name !== 'NotificationConfiguration') {
    throw new S3Error('MalformedXML', 'Expected a NotificationConfiguration element')
  }
  const targets = childrenNamed(root, 'WebhookConfiguration').map((node, index) => {
    const endpoint = childText(node, 'Endpoint')
    if (!endpoint) throw new S3Error('MalformedXML', 'Each WebhookConfiguration requires an Endpoint')
    let url: URL
    try {
      url = new URL(endpoint)
    } catch {
      throw new S3Error('MalformedXML', `Invalid webhook endpoint ${endpoint}`)
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new S3Error('MalformedXML', 'Webhook endpoints must be http or https')
    }
    const events = childrenNamed(node, 'Event').map((event) => event.text)
    if (events.length === 0) throw new S3Error('MalformedXML', 'Each WebhookConfiguration requires an Event')
    for (const event of events) {
      if (!KNOWN_EVENTS.includes(event)) {
        throw new S3Error('MalformedXML', `Unsupported event ${event}`)
      }
    }
    return { id: childText(node, 'Id') ?? `webhook-${index}`, endpoint, events, filter: parseFilter(node) }
  })
  return { targets }
}

export function notificationXml(config: NotificationConfig): string {
  const targets = (config?.targets ?? []).map((target) => {
    const rules = Object.entries(target.filter ?? {})
      .map(([name, value]) => `<FilterRule>${text('Name', name)}${text('Value', value)}</FilterRule>`)
      .join('')
    return '<WebhookConfiguration>' +
      text('Id', target.id) +
      text('Endpoint', target.endpoint) +
      target.events.map((event) => text('Event', event)).join('') +
      (rules ? `<Filter><S3Key>${rules}</S3Key></Filter>` : '') +
      '</WebhookConfiguration>'
  }).join('')
  return document('NotificationConfiguration', targets)
}

function eventMatches(pattern: string, eventName: string): boolean {
  const full = `s3:${eventName}`
  if (pattern === full) return true
  if (!pattern.endsWith(':*')) return false
  return full.startsWith(pattern.slice(0, -1))
}

function filterMatches(filter: NotificationFilter, key: string): boolean {
  if (filter.prefix !== undefined && !key.startsWith(filter.prefix)) return false
  if (filter.suffix !== undefined && !key.endsWith(filter.suffix)) return false
  return true
}

export function buildEvent({ eventName, region, bucket, key, size, etag, versionId, configurationId }: {
  eventName: string
  region: string
  bucket: string
  key: string
  size?: number
  etag?: string
  versionId?: string
  configurationId?: string
}): Record<string, unknown> {
  return {
    Records: [{
      eventVersion: '2.1',
      eventSource: 'aws:s3',
      awsRegion: region,
      eventTime: new Date().toISOString(),
      eventName,
      s3: {
        s3SchemaVersion: '1.0',
        configurationId,
        bucket: { name: bucket, arn: `arn:aws:s3:::${bucket}` },
        object: {
          key: encodeURIComponent(key).replaceAll('%2F', '/'),
          size,
          eTag: etag ? etag.replaceAll('"', '') : undefined,
          versionId,
        },
      },
    }],
  }
}

/**
 * All the dispatcher needs from a store: the bucket's notification document,
 * plus the persistent queue primitives. ObjectStore/MetadataStore satisfy
 * this structurally.
 */
export interface NotificationConfigSource {
  metadata: {
    getConfig<T>(bucket: string, name: string): T | null
    enqueueNotification(row: { bucket: string; targetId: string; endpoint: string; payload: string; now: number }): void
    claimDueNotifications(now: number, limit?: number): NotificationQueueRow[]
    rescheduleNotification(id: number, attempts: number, nextAttemptAt: number): void
    deadLetterNotification(id: number, attempts: number): void
    deleteNotification(id: number): void
  }
}

export interface NotificationLogger {
  error?: (entry: Record<string, unknown>) => void
}

export interface NotificationDispatcherOptions {
  region?: string
  logger?: NotificationLogger | null | undefined
  fetchImpl?: typeof fetch
  /** Injectable clock, so tests can advance retry backoff without real sleeps. */
  now?: () => number
  /** Failed deliveries beyond this many attempts move to the dead letter status instead of retrying again. */
  maxAttempts?: number
  baseBackoffMs?: number
  maxBackoffMs?: number
  /** How often the background worker sweeps the queue for due deliveries. 0 disables the worker (drain() still works). */
  intervalMs?: number
}

const DEFAULT_MAX_ATTEMPTS = 6
const DEFAULT_BASE_BACKOFF_MS = 1000
const DEFAULT_MAX_BACKOFF_MS = 60_000
const DEFAULT_INTERVAL_MS = 2000

/**
 * Enqueues matching events into a SQLite-backed queue and delivers them from
 * a periodic worker with exponential backoff, so a webhook that's briefly
 * down doesn't silently drop events the way a fire-and-forget `fetch()`
 * would. Failed deliveries retry up to `maxAttempts` times before moving to
 * the `dead` status for manual inspection/replay.
 */
export class NotificationDispatcher {
  store: NotificationConfigSource
  region: string
  logger: NotificationLogger | null
  fetchImpl: typeof fetch
  now: () => number
  maxAttempts: number
  baseBackoffMs: number
  maxBackoffMs: number
  inFlight: Set<Promise<void>>
  private timer: ReturnType<typeof setInterval> | null

  constructor(store: NotificationConfigSource, {
    region = 'us-east-1', logger = null, fetchImpl = fetch, now = Date.now,
    maxAttempts = DEFAULT_MAX_ATTEMPTS, baseBackoffMs = DEFAULT_BASE_BACKOFF_MS, maxBackoffMs = DEFAULT_MAX_BACKOFF_MS,
    intervalMs = DEFAULT_INTERVAL_MS,
  }: NotificationDispatcherOptions = {}) {
    this.store = store
    this.region = region
    this.logger = logger
    this.fetchImpl = fetchImpl
    this.now = now
    this.maxAttempts = maxAttempts
    this.baseBackoffMs = baseBackoffMs
    this.maxBackoffMs = maxBackoffMs
    this.inFlight = new Set()
    this.timer = intervalMs > 0
      ? setInterval(() => { this.processQueue().catch(() => {}) }, intervalMs)
      : null
    this.timer?.unref?.()
  }

  /** Matches the event against the bucket's configured targets and enqueues one row per match. Never touches the network. */
  dispatch({ bucket, eventName, key, size, etag, versionId }: {
    bucket: string
    eventName: string
    key: string
    size?: number
    etag?: string
    versionId?: string
  }): void {
    let config: NotificationConfig | null
    try {
      config = this.store.metadata.getConfig<NotificationConfig>(bucket, 'notification')
    } catch {
      return
    }
    if (!config?.targets?.length) return

    const now = this.now()
    for (const target of config.targets) {
      if (!target.events.some((pattern) => eventMatches(pattern, eventName))) continue
      if (!filterMatches(target.filter ?? {}, key)) continue

      const payload = buildEvent({
        eventName, region: this.region, bucket, key, size, etag, versionId,
        configurationId: target.id,
      })
      this.store.metadata.enqueueNotification({
        bucket, targetId: target.id, endpoint: target.endpoint, payload: JSON.stringify(payload), now,
      })
    }
  }

  /** One sweep: claims due rows and attempts delivery for each. Safe to call concurrently with the background worker. */
  async processQueue(): Promise<void> {
    const due = this.store.metadata.claimDueNotifications(this.now())
    await Promise.allSettled(due.map((row) => this._attempt(row)))
  }

  private _attempt(row: NotificationQueueRow): Promise<void> {
    const promise: Promise<void> = (this.fetchImpl(row.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-amz-event-source': 's3node' } as Record<string, string>,
      body: row.payload,
      signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
    }) as Promise<Response>).then(() => {
      this.store.metadata.deleteNotification(row.id)
    }).catch((err: Error) => {
      const attempts = row.attempts + 1
      if (attempts >= this.maxAttempts) {
        this.store.metadata.deadLetterNotification(row.id, attempts)
        this.logger?.error?.({
          message: 'notification moved to dead-letter', endpoint: row.endpoint, attempts, error: err.message,
        })
        return
      }
      const backoffMs = Math.min(this.baseBackoffMs * 2 ** row.attempts, this.maxBackoffMs)
      this.store.metadata.rescheduleNotification(row.id, attempts, this.now() + backoffMs)
      this.logger?.error?.({
        message: 'notification delivery failed, retrying', endpoint: row.endpoint, attempts, error: err.message,
      })
    }).finally(() => this.inFlight.delete(promise)) as Promise<void>
    this.inFlight.add(promise)
    return promise
  }

  /** Runs one queue sweep and waits for everything it kicked off — used by tests and graceful shutdown. */
  async drain(): Promise<void> {
    await this.processQueue()
    while (this.inFlight.size) await Promise.allSettled([...this.inFlight])
  }

  close(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}

export { KNOWN_EVENTS }
export type { NotificationQueueRow } from '../storage/metadata.js'
