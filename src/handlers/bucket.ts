import type { ServerResponse } from 'node:http'
import { S3Error } from '../errors.js'
import { collectBody, isoDate, sendEmpty, sendXml, type RequestContext } from '../http.js'
import { childText, childrenNamed, document, escapeXml, parseXml, text } from '../xml.js'
import { MAX_DELETE_KEYS, integerParam, maybeEncode, ownerXml } from './shared.js'
import { notify } from './shared.js'
import type { ObjectStore } from '../storage/store.js'
import type { S3NodeServer } from '../server.js'

export async function createBucket(ctx: RequestContext, res: ServerResponse, { store }: { store: ObjectStore }): Promise<void> {
  await collectBody(ctx.bodyStreams).catch(() => Buffer.alloc(0))
  store.createBucket(ctx.bucket)
  sendEmpty(ctx, res, 200, { Location: `/${ctx.bucket}` })
}

export async function deleteBucket(ctx: RequestContext, res: ServerResponse, { store }: { store: ObjectStore }): Promise<void> {
  await store.deleteBucket(ctx.bucket)
  sendEmpty(ctx, res, 204)
}

export function headBucket(ctx: RequestContext, res: ServerResponse, { store }: { store: ObjectStore }): void {
  store.requireBucket(ctx.bucket)
  sendEmpty(ctx, res, 200, { 'x-amz-bucket-region': store.region })
}

export function getBucketLocation(ctx: RequestContext, res: ServerResponse, { store }: { store: ObjectStore }): void {
  store.requireBucket(ctx.bucket)
  const constraint = store.region === 'us-east-1' ? '' : escapeXml(store.region)
  sendXml(ctx, res, 200, document('LocationConstraint', constraint))
}

function listCommon(ctx: RequestContext): { prefix: string; delimiter: string; encodingType: string; maxKeys: number } {
  return {
    prefix: ctx.query.get('prefix') ?? '',
    delimiter: ctx.query.get('delimiter') ?? '',
    encodingType: ctx.query.get('encoding-type') ?? '',
    maxKeys: integerParam(ctx.query, 'max-keys', 1000, { min: 0, max: 1000 }),
  }
}

function contentsXml(records: { key: Buffer; lastModified: Date; etag: string; size: number }[], encodingType: string, { withOwner }: { withOwner: boolean }): string {
  return records.map((record) => (
    `<Contents>${
      text('Key', maybeEncode(record.key.toString('utf8'), encodingType))
    }${text('LastModified', isoDate(record.lastModified))
    }${text('ETag', record.etag)
    }${text('Size', record.size)
    }${text('StorageClass', 'STANDARD')
    }${withOwner ? ownerXml : ''}</Contents>`
  )).join('')
}

function prefixesXml(prefixes: string[], encodingType: string): string {
  return prefixes
    .map((value) => `<CommonPrefixes>${text('Prefix', maybeEncode(value, encodingType))}</CommonPrefixes>`)
    .join('')
}

export function listObjectsV2(ctx: RequestContext, res: ServerResponse, { store }: { store: ObjectStore }): void {
  const { prefix, delimiter, encodingType, maxKeys } = listCommon(ctx)
  const continuationToken = ctx.query.get('continuation-token')
  const startAfter = ctx.query.get('start-after') ?? ''
  const fetchOwner = ctx.query.get('fetch-owner') === 'true'

  const cursor = continuationToken ? Buffer.from(continuationToken, 'base64') : null
  const result = store.listObjects(ctx.bucket, { prefix, delimiter, maxKeys, startAfter, cursor })

  const body =
    text('Name', ctx.bucket) +
    text('Prefix', maybeEncode(prefix, encodingType)) +
    (delimiter ? text('Delimiter', maybeEncode(delimiter, encodingType)) : '') +
    text('MaxKeys', maxKeys) +
    text('KeyCount', result.contents.length + result.commonPrefixes.length) +
    text('IsTruncated', String(result.truncated)) +
    (continuationToken ? text('ContinuationToken', continuationToken) : '') +
    (result.truncated && result.nextCursor
      ? text('NextContinuationToken', Buffer.from(result.nextCursor).toString('base64'))
      : '') +
    (startAfter ? text('StartAfter', maybeEncode(startAfter, encodingType)) : '') +
    (encodingType ? text('EncodingType', encodingType) : '') +
    contentsXml(result.contents, encodingType, { withOwner: fetchOwner }) +
    prefixesXml(result.commonPrefixes, encodingType)

  sendXml(ctx, res, 200, document('ListBucketResult', body))
}

export function listObjectsV1(ctx: RequestContext, res: ServerResponse, { store }: { store: ObjectStore }): void {
  const { prefix, delimiter, encodingType, maxKeys } = listCommon(ctx)
  const marker = ctx.query.get('marker') ?? ''
  const result = store.listObjects(ctx.bucket, { prefix, delimiter, maxKeys, startAfter: marker })

  const candidates = [
    result.contents.at(-1)?.key.toString('utf8'),
    result.commonPrefixes.at(-1),
  ].filter((value): value is string => value !== undefined)
  const lastKey = candidates.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))).at(-1)

  const body =
    text('Name', ctx.bucket) +
    text('Prefix', maybeEncode(prefix, encodingType)) +
    text('Marker', maybeEncode(marker, encodingType)) +
    (delimiter ? text('Delimiter', maybeEncode(delimiter, encodingType)) : '') +
    text('MaxKeys', maxKeys) +
    text('IsTruncated', String(result.truncated)) +
    (result.truncated && lastKey ? text('NextMarker', maybeEncode(lastKey, encodingType)) : '') +
    (encodingType ? text('EncodingType', encodingType) : '') +
    contentsXml(result.contents, encodingType, { withOwner: true }) +
    prefixesXml(result.commonPrefixes, encodingType)

  sendXml(ctx, res, 200, document('ListBucketResult', body))
}

export function listObjectVersions(ctx: RequestContext, res: ServerResponse, { store }: { store: ObjectStore }): void {
  const { prefix, delimiter, encodingType, maxKeys } = listCommon(ctx)
  const keyMarker = ctx.query.get('key-marker') ?? ''
  const versionIdMarker = ctx.query.get('version-id-marker') ?? ''

  const result = store.listVersions(ctx.bucket, {
    prefix, delimiter, maxKeys, keyMarker, versionIdMarker,
  })

  const entries = result.versions.map((record) => {
    const common =
      text('Key', maybeEncode(record.key.toString('utf8'), encodingType)) +
      text('VersionId', record.versionId) +
      text('IsLatest', String(record.isLatest)) +
      text('LastModified', isoDate(record.lastModified))
    return record.isDeleteMarker
      ? `<DeleteMarker>${common}${ownerXml}</DeleteMarker>`
      : `<Version>${common}${text('ETag', record.etag)}${text('Size', record.size)}` +
        `${text('StorageClass', 'STANDARD')}${ownerXml}</Version>`
  }).join('')

  const body =
    text('Name', ctx.bucket) +
    text('Prefix', maybeEncode(prefix, encodingType)) +
    (delimiter ? text('Delimiter', maybeEncode(delimiter, encodingType)) : '') +
    text('KeyMarker', maybeEncode(keyMarker, encodingType)) +
    (versionIdMarker ? text('VersionIdMarker', versionIdMarker) : '') +
    text('MaxKeys', maxKeys) +
    text('IsTruncated', String(result.truncated)) +
    (result.nextKeyMarker ? text('NextKeyMarker', maybeEncode(result.nextKeyMarker, encodingType)) : '') +
    (result.nextVersionIdMarker ? text('NextVersionIdMarker', result.nextVersionIdMarker) : '') +
    (encodingType ? text('EncodingType', encodingType) : '') +
    entries +
    prefixesXml(result.commonPrefixes, encodingType)

  sendXml(ctx, res, 200, document('ListVersionsResult', body))
}

export async function deleteObjects(ctx: RequestContext, res: ServerResponse, { store, server }: { store: ObjectStore; server: S3NodeServer }): Promise<void> {
  store.requireBucket(ctx.bucket)
  const body = await collectBody(ctx.bodyStreams)
  const root = parseXml(body)
  if (root.name !== 'Delete') throw new S3Error('MalformedXML', 'Expected a Delete element')

  const quiet = childText(root, 'Quiet') === 'true'
  const entries = childrenNamed(root, 'Object')
  if (entries.length === 0) throw new S3Error('MalformedXML', 'No objects specified')
  if (entries.length > MAX_DELETE_KEYS) {
    throw new S3Error('MalformedXML', `A maximum of ${MAX_DELETE_KEYS} keys may be deleted in one request`)
  }

  const deleted: { key: string; versionId?: string; deleteMarker?: boolean }[] = []
  const errors: { key: string; code: string; message: string }[] = []
  for (const entry of entries) {
    const key = childText(entry, 'Key')
    if (!key) {
      errors.push({ key: '', code: 'MalformedXML', message: 'Missing Key' })
      continue
    }
    const versionId = childText(entry, 'VersionId')
    try {
      const result = await store.deleteObject(ctx.bucket, key, versionId ?? null)
      deleted.push({ key, ...result })
      notify(server, {
        bucket: ctx.bucket,
        eventName: result.deleteMarker ? 'ObjectRemoved:DeleteMarkerCreated' : 'ObjectRemoved:Delete',
        key, size: 0, versionId: result.versionId,
      })
    } catch (err) {
      const s3 = err instanceof S3Error ? err : new S3Error('InternalError', (err as Error).message)
      errors.push({ key, code: s3.code, message: s3.message })
    }
  }

  const payload =
    (quiet ? '' : deleted.map((entry) =>
      `<Deleted>${text('Key', entry.key)}${
        entry.versionId ? text('VersionId', entry.versionId) : ''
      }${entry.deleteMarker ? text('DeleteMarker', 'true') : ''}</Deleted>`
    ).join('')) +
    errors.map((entry) =>
      `<Error>${text('Key', entry.key)}${text('Code', entry.code)}${text('Message', entry.message)}</Error>`
    ).join('')

  sendXml(ctx, res, 200, document('DeleteResult', payload))
}
