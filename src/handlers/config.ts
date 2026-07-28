import type { ServerResponse } from 'node:http'
import { S3Error } from '../errors.js'
import { collectBody, sendEmpty, sendXml, type RequestContext } from '../http.js'
import { corsXml, parseCorsXml } from '../features/cors.js'
import type { CorsConfig } from '../features/cors.js'
import { lifecycleXml, parseLifecycleXml } from '../features/lifecycle.js'
import type { LifecycleConfig } from '../features/lifecycle.js'
import { notificationXml, parseNotificationXml } from '../features/notifications.js'
import type { NotificationConfig } from '../features/notifications.js'
import { parsePolicy } from '../features/policy.js'
import { MAX_BUCKET_TAGS, parseTaggingXml, taggingXml } from '../features/tagging.js'
import { childText, document, parseXml, text } from '../xml.js'
import type { ObjectStore } from '../storage/store.js'

export function getBucketVersioning(ctx: RequestContext, res: ServerResponse, { store }: { store: ObjectStore }): void {
  const status = store.bucketVersioning(ctx.bucket)
  sendXml(ctx, res, 200, document('VersioningConfiguration',
    status === 'Unset' ? '' : text('Status', status)))
}

export async function putBucketVersioning(ctx: RequestContext, res: ServerResponse, { store }: { store: ObjectStore }): Promise<void> {
  store.requireBucket(ctx.bucket)
  const root = parseXml(await collectBody(ctx.bodyStreams))
  if (root.name !== 'VersioningConfiguration') {
    throw new S3Error('MalformedXML', 'Expected a VersioningConfiguration element')
  }
  const status = childText(root, 'Status')
  if (status !== 'Enabled' && status !== 'Suspended') {
    throw new S3Error('IllegalVersioningConfigurationException',
      'The versioning status must be Enabled or Suspended')
  }
  store.putBucketConfig(ctx.bucket, 'versioning', { status })
  sendEmpty(ctx, res, 200)
}

export function getBucketPolicy(ctx: RequestContext, res: ServerResponse, { store }: { store: ObjectStore }): void {
  const policy = store.getBucketConfig(ctx.bucket, 'policy')
  if (!policy) throw new S3Error('NoSuchBucketPolicy')
  const body = Buffer.from(JSON.stringify(policy), 'utf8')
  res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': body.length })
  res.end(body)
}

export async function putBucketPolicy(ctx: RequestContext, res: ServerResponse, { store }: { store: ObjectStore }): Promise<void> {
  store.requireBucket(ctx.bucket)
  const policy = parsePolicy(await collectBody(ctx.bodyStreams))
  store.putBucketConfig(ctx.bucket, 'policy', policy)
  sendEmpty(ctx, res, 204)
}

export function deleteBucketPolicy(ctx: RequestContext, res: ServerResponse, { store }: { store: ObjectStore }): void {
  store.deleteBucketConfig(ctx.bucket, 'policy')
  sendEmpty(ctx, res, 204)
}

export function getBucketCors(ctx: RequestContext, res: ServerResponse, { store }: { store: ObjectStore }): void {
  const config = store.getBucketConfig<CorsConfig>(ctx.bucket, 'cors')
  if (!config) throw new S3Error('NoSuchCORSConfiguration')
  sendXml(ctx, res, 200, corsXml(config))
}

export async function putBucketCors(ctx: RequestContext, res: ServerResponse, { store }: { store: ObjectStore }): Promise<void> {
  store.requireBucket(ctx.bucket)
  store.putBucketConfig(ctx.bucket, 'cors', parseCorsXml(await collectBody(ctx.bodyStreams)))
  sendEmpty(ctx, res, 200)
}

export function deleteBucketCors(ctx: RequestContext, res: ServerResponse, { store }: { store: ObjectStore }): void {
  store.deleteBucketConfig(ctx.bucket, 'cors')
  sendEmpty(ctx, res, 204)
}

export function getBucketLifecycle(ctx: RequestContext, res: ServerResponse, { store }: { store: ObjectStore }): void {
  const config = store.getBucketConfig<LifecycleConfig>(ctx.bucket, 'lifecycle')
  if (!config) throw new S3Error('NoSuchLifecycleConfiguration')
  sendXml(ctx, res, 200, lifecycleXml(config))
}

export async function putBucketLifecycle(ctx: RequestContext, res: ServerResponse, { store }: { store: ObjectStore }): Promise<void> {
  store.requireBucket(ctx.bucket)
  store.putBucketConfig(ctx.bucket, 'lifecycle', parseLifecycleXml(await collectBody(ctx.bodyStreams)))
  sendEmpty(ctx, res, 200)
}

export function deleteBucketLifecycle(ctx: RequestContext, res: ServerResponse, { store }: { store: ObjectStore }): void {
  store.deleteBucketConfig(ctx.bucket, 'lifecycle')
  sendEmpty(ctx, res, 204)
}

export function getBucketTagging(ctx: RequestContext, res: ServerResponse, { store }: { store: ObjectStore }): void {
  const tags = store.getBucketConfig<Record<string, string>>(ctx.bucket, 'tagging')
  if (!tags || Object.keys(tags).length === 0) throw new S3Error('NoSuchTagSet')
  sendXml(ctx, res, 200, taggingXml(tags))
}

export async function putBucketTagging(ctx: RequestContext, res: ServerResponse, { store }: { store: ObjectStore }): Promise<void> {
  store.requireBucket(ctx.bucket)
  const tags = parseTaggingXml(await collectBody(ctx.bodyStreams), { max: MAX_BUCKET_TAGS })
  store.putBucketConfig(ctx.bucket, 'tagging', tags)
  sendEmpty(ctx, res, 204)
}

export function deleteBucketTagging(ctx: RequestContext, res: ServerResponse, { store }: { store: ObjectStore }): void {
  store.deleteBucketConfig(ctx.bucket, 'tagging')
  sendEmpty(ctx, res, 204)
}

export function getBucketNotification(ctx: RequestContext, res: ServerResponse, { store }: { store: ObjectStore }): void {
  const config = store.getBucketConfig<NotificationConfig>(ctx.bucket, 'notification')
  sendXml(ctx, res, 200, notificationXml(config ?? { targets: [] }))
}

export async function putBucketNotification(ctx: RequestContext, res: ServerResponse, { store }: { store: ObjectStore }): Promise<void> {
  store.requireBucket(ctx.bucket)
  const config = parseNotificationXml(await collectBody(ctx.bodyStreams))
  if (config.targets.length === 0) {
    store.deleteBucketConfig(ctx.bucket, 'notification')
  } else {
    store.putBucketConfig(ctx.bucket, 'notification', config)
  }
  sendEmpty(ctx, res, 200)
}
