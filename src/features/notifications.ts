import { S3Error } from '../errors.js'
import { lookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import type { NotificationQueueRow } from '../storage/metadata.js'
import { childNamed, childText, childrenNamed, document, parseXml, text } from '../xml.js'

const DISPATCH_TIMEOUT_MS = 5000
const MAX_TARGETS = 100

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
    if (url.username || url.password) {
      throw new S3Error('MalformedXML', 'Webhook endpoints must not contain credentials')
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
  if (targets.length > MAX_TARGETS) {
    throw new S3Error('MalformedXML', `A maximum of ${MAX_TARGETS} webhook targets is allowed`)
  }
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
  size?: number | undefined
  etag?: string | undefined
  versionId?: string | undefined
  configurationId?: string | undefined
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
    claimDueNotifications(now: number, limit?: number, leaseMs?: number): NotificationQueueRow[]
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
  intervalMs?: number | undefined
  /** Explicit opt-in for loopback/private webhook destinations. */
  allowPrivateEndpoints?: boolean | undefined
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
  private readonly allowPrivateEndpoints: boolean

  constructor(store: NotificationConfigSource, {
    region = 'us-east-1', logger = null, fetchImpl = fetch, now = Date.now,
    maxAttempts = DEFAULT_MAX_ATTEMPTS, baseBackoffMs = DEFAULT_BASE_BACKOFF_MS, maxBackoffMs = DEFAULT_MAX_BACKOFF_MS,
    intervalMs = DEFAULT_INTERVAL_MS, allowPrivateEndpoints = false,
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
    this.allowPrivateEndpoints = allowPrivateEndpoints
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
    size?: number | undefined
    etag?: string | undefined
    versionId?: string | undefined
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
    const promise = this._deliver(row).finally(() => this.inFlight.delete(promise))
    this.inFlight.add(promise)
    return promise
  }

  private async _deliver(row: NotificationQueueRow): Promise<void> {
    try {
      const status = this.fetchImpl === fetch
        ? await this._deliverPinned(row.endpoint, row.payload)
        : await this._deliverInjected(row.endpoint, row.payload)
      if (status < 200 || status >= 300) throw new Error(`Webhook returned HTTP ${status}`)
      this.store.metadata.deleteNotification(row.id)
    } catch (err) {
      const attempts = row.attempts + 1
      if (attempts >= this.maxAttempts) {
        this.store.metadata.deadLetterNotification(row.id, attempts)
        this.logger?.error?.({
          message: 'notification moved to dead-letter', endpoint: row.endpoint, attempts, error: (err as Error).message,
        })
        return
      }
      const backoffMs = Math.min(this.baseBackoffMs * 2 ** row.attempts, this.maxBackoffMs)
      this.store.metadata.rescheduleNotification(row.id, attempts, this.now() + backoffMs)
      this.logger?.error?.({
        message: 'notification delivery failed, retrying', endpoint: row.endpoint, attempts, error: (err as Error).message,
      })
    }
  }

  private async _deliverInjected(endpoint: string, payload: string): Promise<number> {
    const response = await this.fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-amz-event-source': 's3node' } as Record<string, string>,
      body: payload,
      signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
      redirect: 'error',
    })
    await response.body?.cancel().catch(() => {})
    return response.status
  }

  /** Resolves once, validates every answer, then pins the actual connection to that result. */
  private async _deliverPinned(endpoint: string, payload: string): Promise<number> {
    const url = new URL(endpoint)
    if (url.username || url.password) throw new Error('Webhook endpoints must not contain credentials')
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Webhook endpoints must use http or https')
    if (!this.allowPrivateEndpoints && url.hostname.toLowerCase() === 'localhost') {
      throw new Error('Private webhook endpoints are disabled')
    }
    const addresses = isIP(url.hostname)
      ? [{ address: url.hostname, family: isIP(url.hostname) }]
      : await lookup(url.hostname, { all: true, verbatim: true })
    if (addresses.length === 0) throw new Error('Webhook endpoint did not resolve')
    if (!this.allowPrivateEndpoints && addresses.some(({ address }) => isPrivateAddress(address))) {
      throw new Error('Private webhook endpoints are disabled')
    }
    const selected = addresses[0]!
    const body = Buffer.from(payload, 'utf8')

    return new Promise<number>((resolve, reject) => {
      const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': body.length,
          'x-amz-event-source': 's3node',
        },
        // Pin DNS to the address that was validated above. HTTPS still uses
        // the URL hostname for SNI and certificate verification.
        lookup: ((_hostname: string, _options: unknown, callback: (...args: unknown[]) => void) => {
          callback(null, selected.address, selected.family)
        }) as never,
      }, (response) => {
        const status = response.statusCode ?? 0
        response.destroy()
        clearTimeout(deadline)
        resolve(status)
      })
      const deadline = setTimeout(
        () => request.destroy(new Error('Webhook delivery timed out')),
        DISPATCH_TIMEOUT_MS,
      )
      deadline.unref?.()
      request.once('error', (err) => {
        clearTimeout(deadline)
        reject(err)
      })
      request.end(body)
    })
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

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase()
  // IPv4-mapped IPv6 addresses may be rendered in dotted or hexadecimal
  // notation. Treat the entire mapped range as private here, then let callers
  // explicitly opt in when private notification endpoints are intentional.
  if (normalized.startsWith('::ffff:') && !/^::ffff:(\d+\.){3}\d+$/.test(normalized)) return true
  if (normalized === '::1' || normalized === '::' || normalized.startsWith('fc') ||
      normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') ||
      normalized.startsWith('fea') || normalized.startsWith('feb') || normalized.startsWith('ff') ||
      normalized.startsWith('2001:db8:')) return true
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized)?.[1]
  const ipv4 = mapped ?? (isIP(normalized) === 4 ? normalized : null)
  if (!ipv4) return false
  const [a, b, c] = ipv4.split('.').map(Number)
  return a === 0 || a === 10 || a === 127 || a! >= 224 ||
    (a === 100 && b! >= 64 && b! <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && (b === 0 || b === 2 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
}
