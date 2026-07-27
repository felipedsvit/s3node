import { S3Error } from '../errors.js'
import { childNamed, childText, childrenNamed, document, parseXml, text } from '../xml.js'
import { toKeyBuffer } from '../util/bytes.js'

const DAY_MS = 24 * 60 * 60 * 1000
const MAX_RULES = 1000

function optionalInt(node, name) {
  const value = childText(node, name)
  if (value === undefined) return undefined
  const parsed = Number.parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new S3Error('MalformedXML', `Invalid ${name}`)
  }
  return parsed
}

function parseFilter(rule) {
  // Rules may carry a bare <Prefix> (legacy) or a <Filter>.
  const legacyPrefix = childText(rule, 'Prefix')
  const filter = childNamed(rule, 'Filter')
  if (!filter) return { prefix: legacyPrefix ?? '' }
  const and = childNamed(filter, 'And')
  const scope = and ?? filter
  const tags = {}
  for (const tag of childrenNamed(scope, 'Tag')) {
    const key = childText(tag, 'Key')
    if (key) tags[key] = childText(tag, 'Value') ?? ''
  }
  return { prefix: childText(scope, 'Prefix') ?? '', tags }
}

export function parseLifecycleXml(body) {
  const root = parseXml(body)
  if (root.name !== 'LifecycleConfiguration' && root.name !== 'BucketLifecycleConfiguration') {
    throw new S3Error('MalformedXML', 'Expected a LifecycleConfiguration element')
  }
  const rules = childrenNamed(root, 'Rule').map((rule, index) => {
    const status = childText(rule, 'Status')
    if (status !== 'Enabled' && status !== 'Disabled') {
      throw new S3Error('MalformedXML', 'Each Rule requires a Status of Enabled or Disabled')
    }
    const expiration = childNamed(rule, 'Expiration')
    const noncurrent = childNamed(rule, 'NoncurrentVersionExpiration')
    const abort = childNamed(rule, 'AbortIncompleteMultipartUpload')
    if (!expiration && !noncurrent && !abort) {
      throw new S3Error('MalformedXML', 'Each Rule requires at least one action')
    }
    const expirationDate = expiration ? childText(expiration, 'Date') : undefined
    if (expirationDate !== undefined && Number.isNaN(Date.parse(expirationDate))) {
      throw new S3Error('MalformedXML', 'Invalid Expiration Date')
    }
    return {
      id: childText(rule, 'ID') ?? `rule-${index}`,
      status,
      filter: parseFilter(rule),
      expirationDays: expiration ? optionalInt(expiration, 'Days') : undefined,
      expirationDate,
      expiredObjectDeleteMarker: expiration
        ? childText(expiration, 'ExpiredObjectDeleteMarker') === 'true'
        : false,
      noncurrentDays: noncurrent ? optionalInt(noncurrent, 'NoncurrentDays') : undefined,
      abortAfterDays: abort ? optionalInt(abort, 'DaysAfterInitiation') : undefined,
    }
  })
  if (rules.length === 0) throw new S3Error('MalformedXML', 'At least one Rule is required')
  if (rules.length > MAX_RULES) {
    throw new S3Error('MalformedXML', `A maximum of ${MAX_RULES} lifecycle rules is allowed`)
  }
  return { rules }
}

export function lifecycleXml(config) {
  const rules = (config?.rules ?? []).map((rule) => {
    const filter = `<Filter>${rule.filter.prefix ? text('Prefix', rule.filter.prefix) : ''}${
      Object.entries(rule.filter.tags ?? {})
        .map(([key, value]) => `<Tag>${text('Key', key)}${text('Value', value)}</Tag>`).join('')
    }</Filter>`
    const expiration = rule.expirationDays !== undefined || rule.expirationDate || rule.expiredObjectDeleteMarker
      ? `<Expiration>${
          rule.expirationDays !== undefined ? text('Days', rule.expirationDays) : ''
        }${rule.expirationDate ? text('Date', rule.expirationDate) : ''
        }${rule.expiredObjectDeleteMarker ? text('ExpiredObjectDeleteMarker', 'true') : ''}</Expiration>`
      : ''
    const noncurrent = rule.noncurrentDays !== undefined
      ? `<NoncurrentVersionExpiration>${text('NoncurrentDays', rule.noncurrentDays)}</NoncurrentVersionExpiration>`
      : ''
    const abort = rule.abortAfterDays !== undefined
      ? `<AbortIncompleteMultipartUpload>${
          text('DaysAfterInitiation', rule.abortAfterDays)}</AbortIncompleteMultipartUpload>`
      : ''
    return `<Rule>${text('ID', rule.id)}${filter}${text('Status', rule.status)}${expiration}${noncurrent}${abort}</Rule>`
  }).join('')
  return document('LifecycleConfiguration', rules)
}

function ruleMatches(rule, record) {
  const prefix = toKeyBuffer(rule.filter.prefix ?? '')
  if (prefix.length && !record.key.subarray(0, prefix.length).equals(prefix)) return false
  for (const [key, value] of Object.entries(rule.filter.tags ?? {})) {
    if ((record.tags ?? {})[key] !== value) return false
  }
  return true
}

function isExpired(rule, timestamp, now) {
  if (rule.expirationDate !== undefined) return now >= Date.parse(rule.expirationDate)
  if (rule.expirationDays !== undefined) return now - timestamp >= rule.expirationDays * DAY_MS
  return false
}

/**
 * Applies expiration rules across every bucket that has a lifecycle
 * configuration. Returns a summary so callers can log or assert on it.
 *
 * Deliberately explicit rather than implicit: `ObjectStore` does not run this
 * on its own, the server schedules it.
 */
export async function runLifecycle(store, { now = Date.now() } = {}) {
  const summary = { expiredObjects: 0, expiredVersions: 0, abortedUploads: 0 }

  for (const { bucket, value: config } of store.metadata.bucketsWithConfig('lifecycle')) {
    if (!store.metadata.getBucket(bucket)) continue
    const rules = (config.rules ?? []).filter((rule) => rule.status === 'Enabled')
    if (rules.length === 0) continue

    for (const rule of rules) {
      if (rule.abortAfterDays !== undefined) {
        const cutoff = now - rule.abortAfterDays * DAY_MS
        for (const upload of store.metadata.uploadsStartedBefore(bucket, cutoff)) {
          if (!ruleMatches(rule, { key: upload.key, tags: upload.tags })) continue
          await store.abortMultipartUpload({
            bucket, key: upload.key.toString('utf8'), uploadId: upload.uploadId,
          })
          summary.abortedUploads++
        }
      }
    }

    // Walk every version once and let each rule vote on it.
    for (const record of store.metadata.objectsModifiedBefore(bucket, now + 1)) {
      for (const rule of rules) {
        if (!ruleMatches(rule, record)) continue

        if (!record.isLatest && rule.noncurrentDays !== undefined) {
          if (now - record.lastModified.getTime() >= rule.noncurrentDays * DAY_MS) {
            await store.deleteObject(bucket, record.key.toString('utf8'), record.versionId)
            summary.expiredVersions++
            break
          }
        }

        if (record.isLatest && !record.isDeleteMarker &&
            isExpired(rule, record.lastModified.getTime(), now)) {
          await store.deleteObject(bucket, record.key.toString('utf8'))
          summary.expiredObjects++
          break
        }

        if (record.isLatest && record.isDeleteMarker && rule.expiredObjectDeleteMarker) {
          const remaining = store.metadata.allVersionsOfKey(bucket, record.key)
          if (remaining.length === 1) {
            await store.deleteObject(bucket, record.key.toString('utf8'), record.versionId)
            summary.expiredVersions++
            break
          }
        }
      }
    }
  }

  return summary
}

export { DAY_MS }
