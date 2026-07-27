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

/**
 * There is no SQS or SNS behind this server, so destinations are plain
 * webhooks. The element name is deliberately non-standard rather than
 * pretending to be `<QueueConfiguration>` and silently doing something else.
 */
function parseFilter(node) {
  const filter = childNamed(node, 'Filter')
  const s3Key = filter ? childNamed(filter, 'S3Key') : null
  const rules = {}
  for (const rule of childrenNamed(s3Key, 'FilterRule')) {
    const name = childText(rule, 'Name')?.toLowerCase()
    if (name === 'prefix' || name === 'suffix') rules[name] = childText(rule, 'Value') ?? ''
  }
  return rules
}

export function parseNotificationXml(body) {
  const root = parseXml(body)
  if (root.name !== 'NotificationConfiguration') {
    throw new S3Error('MalformedXML', 'Expected a NotificationConfiguration element')
  }
  const targets = childrenNamed(root, 'WebhookConfiguration').map((node, index) => {
    const endpoint = childText(node, 'Endpoint')
    if (!endpoint) throw new S3Error('MalformedXML', 'Each WebhookConfiguration requires an Endpoint')
    let url
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

export function notificationXml(config) {
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

function eventMatches(pattern, eventName) {
  const full = `s3:${eventName}`
  if (pattern === full) return true
  if (!pattern.endsWith(':*')) return false
  return full.startsWith(pattern.slice(0, -1))
}

function filterMatches(filter, key) {
  if (filter.prefix !== undefined && !key.startsWith(filter.prefix)) return false
  if (filter.suffix !== undefined && !key.endsWith(filter.suffix)) return false
  return true
}

export function buildEvent({ eventName, region, bucket, key, size, etag, versionId, configurationId }) {
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
 * Best-effort, fire-and-forget delivery. A slow or broken webhook must never
 * stall or fail the S3 request that triggered it.
 */
export class NotificationDispatcher {
  constructor(store, { region = 'us-east-1', logger = null, fetchImpl = fetch } = {}) {
    this.store = store
    this.region = region
    this.logger = logger
    this.fetchImpl = fetchImpl
    this.inFlight = new Set()
  }

  dispatch({ bucket, eventName, key, size, etag, versionId }) {
    let config
    try {
      config = this.store.metadata.getConfig(bucket, 'notification')
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
      const promise = this.fetchImpl(target.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-amz-event-source': 's3node' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
      }).catch((err) => {
        this.logger?.error?.({ message: 'notification delivery failed', endpoint: target.endpoint, error: err.message })
      }).finally(() => this.inFlight.delete(promise))
      this.inFlight.add(promise)
    }
  }

  /** Used by tests and shutdown to wait for outstanding deliveries. */
  async drain() {
    while (this.inFlight.size) await Promise.allSettled([...this.inFlight])
  }
}

export { KNOWN_EVENTS }
