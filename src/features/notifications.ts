import { S3Error } from '../errors.js'
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
 * All the dispatcher needs from a store: the ability to read one bucket's
 * notification document. ObjectStore satisfies it structurally.
 */
export interface NotificationConfigSource {
  metadata: { getConfig<T>(bucket: string, name: string): T | null }
}

export interface NotificationLogger {
  error?: (entry: Record<string, unknown>) => void
}

export interface NotificationDispatcherOptions {
  region?: string
  logger?: NotificationLogger | null | undefined
  fetchImpl?: typeof fetch
}

export class NotificationDispatcher {
  store: NotificationConfigSource
  region: string
  logger: NotificationLogger | null
  fetchImpl: typeof fetch
  inFlight: Set<Promise<void>>

  constructor(store: NotificationConfigSource, { region = 'us-east-1', logger = null, fetchImpl = fetch }: NotificationDispatcherOptions = {}) {
    this.store = store
    this.region = region
    this.logger = logger
    this.fetchImpl = fetchImpl
    this.inFlight = new Set()
  }

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

    for (const target of config.targets) {
      if (!target.events.some((pattern) => eventMatches(pattern, eventName))) continue
      if (!filterMatches(target.filter ?? {}, key)) continue

      const payload = buildEvent({
        eventName, region: this.region, bucket, key, size, etag, versionId,
        configurationId: target.id,
      })
      const promise: Promise<void> = (this.fetchImpl(target.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-amz-event-source': 's3node' } as Record<string, string>,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
      }) as Promise<Response>).catch((err: Error) => {
        this.logger?.error?.({ message: 'notification delivery failed', endpoint: target.endpoint, error: err.message })
      }).finally(() => this.inFlight.delete(promise)) as Promise<void>
      this.inFlight.add(promise)
    }
  }

  async drain(): Promise<void> {
    while (this.inFlight.size) await Promise.allSettled([...this.inFlight])
  }
}

export { KNOWN_EVENTS }
