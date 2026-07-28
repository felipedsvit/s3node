import { S3Error } from '../errors.js'
import { childNamed, childText, childrenNamed, document, parseXml, text } from '../xml.js'

const MAX_OBJECT_TAGS = 10
const MAX_BUCKET_TAGS = 50
const MAX_KEY_LENGTH = 128
const MAX_VALUE_LENGTH = 256

export function validateTagSet(tags: Record<string, string>, { max = MAX_OBJECT_TAGS } = {}): Record<string, string> {
  const entries = Object.entries(tags)
  if (entries.length > max) {
    throw new S3Error('InvalidTag', `A maximum of ${max} tags is allowed`)
  }
  for (const [key, value] of entries) {
    if (!key || key.length > MAX_KEY_LENGTH) {
      throw new S3Error('InvalidTag', `Tag key must be between 1 and ${MAX_KEY_LENGTH} characters`)
    }
    if (String(value).length > MAX_VALUE_LENGTH) {
      throw new S3Error('InvalidTag', `Tag value must be at most ${MAX_VALUE_LENGTH} characters`)
    }
  }
  return tags
}

export function parseTaggingHeader(header: string | undefined): Record<string, string> {
  if (!header) return {}
  const tags: Record<string, string> = {}
  for (const pair of String(header).split('&')) {
    if (!pair) continue
    const eq = pair.indexOf('=')
    const rawKey = eq === -1 ? pair : pair.slice(0, eq)
    const rawValue = eq === -1 ? '' : pair.slice(eq + 1)
    try {
      tags[decodeURIComponent(rawKey.replaceAll('+', ' '))] =
        decodeURIComponent(rawValue.replaceAll('+', ' '))
    } catch {
      throw new S3Error('InvalidArgument', 'Malformed x-amz-tagging header')
    }
  }
  return validateTagSet(tags)
}

export function parseTaggingXml(body: string | Buffer, options?: { max?: number }): Record<string, string> {
  const root = parseXml(body)
  if (root.name !== 'Tagging') throw new S3Error('MalformedXML', 'Expected a Tagging element')
  const tagSet = childNamed(root, 'TagSet')
  const tags: Record<string, string> = {}
  for (const tag of childrenNamed(tagSet, 'Tag')) {
    const key = childText(tag, 'Key')
    if (!key) throw new S3Error('MalformedXML', 'Each Tag requires a Key')
    tags[key] = childText(tag, 'Value') ?? ''
  }
  return validateTagSet(tags, options)
}

export function taggingXml(tags: Record<string, string>): string {
  const entries = Object.entries(tags ?? {})
    .map(([key, value]) => `<Tag>${text('Key', key)}${text('Value', value)}</Tag>`)
    .join('')
  return document('Tagging', `<TagSet>${entries}</TagSet>`)
}

export { MAX_BUCKET_TAGS, MAX_OBJECT_TAGS }
