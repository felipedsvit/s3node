import { S3Error } from '../errors.js'
import { collectBody, sendEmpty, sendXml } from '../http.js'
import { corsXml, parseCorsXml } from '../features/cors.js'
import { lifecycleXml, parseLifecycleXml } from '../features/lifecycle.js'
import { notificationXml, parseNotificationXml } from '../features/notifications.js'
import { parsePolicy } from '../features/policy.js'
import { MAX_BUCKET_TAGS, parseTaggingXml, taggingXml } from '../features/tagging.js'
import { childText, document, parseXml, text } from '../xml.js'

/* ----------------------------- versioning ----------------------------- */

export function getBucketVersioning(ctx, res, { store }) {
  const status = store.bucketVersioning(ctx.bucket)
  sendXml(ctx, res, 200, document('VersioningConfiguration',
    status === 'Unset' ? '' : text('Status', status)))
}

export async function putBucketVersioning(ctx, res, { store }) {
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

/* ------------------------------- policy ------------------------------- */

export function getBucketPolicy(ctx, res, { store }) {
  const policy = store.getBucketConfig(ctx.bucket, 'policy')
  if (!policy) throw new S3Error('NoSuchBucketPolicy')
  const body = Buffer.from(JSON.stringify(policy), 'utf8')
  res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': body.length })
  res.end(body)
}

export async function putBucketPolicy(ctx, res, { store }) {
  store.requireBucket(ctx.bucket)
  const policy = parsePolicy(await collectBody(ctx.bodyStreams))
  store.putBucketConfig(ctx.bucket, 'policy', policy)
  sendEmpty(ctx, res, 204)
}

export function deleteBucketPolicy(ctx, res, { store }) {
  store.deleteBucketConfig(ctx.bucket, 'policy')
  sendEmpty(ctx, res, 204)
}

/* -------------------------------- CORS -------------------------------- */

export function getBucketCors(ctx, res, { store }) {
  const config = store.getBucketConfig(ctx.bucket, 'cors')
  if (!config) throw new S3Error('NoSuchCORSConfiguration')
  sendXml(ctx, res, 200, corsXml(config))
}

export async function putBucketCors(ctx, res, { store }) {
  store.requireBucket(ctx.bucket)
  store.putBucketConfig(ctx.bucket, 'cors', parseCorsXml(await collectBody(ctx.bodyStreams)))
  sendEmpty(ctx, res, 200)
}

export function deleteBucketCors(ctx, res, { store }) {
  store.deleteBucketConfig(ctx.bucket, 'cors')
  sendEmpty(ctx, res, 204)
}

/* ----------------------------- lifecycle ------------------------------ */

export function getBucketLifecycle(ctx, res, { store }) {
  const config = store.getBucketConfig(ctx.bucket, 'lifecycle')
  if (!config) throw new S3Error('NoSuchLifecycleConfiguration')
  sendXml(ctx, res, 200, lifecycleXml(config))
}

export async function putBucketLifecycle(ctx, res, { store }) {
  store.requireBucket(ctx.bucket)
  store.putBucketConfig(ctx.bucket, 'lifecycle', parseLifecycleXml(await collectBody(ctx.bodyStreams)))
  sendEmpty(ctx, res, 200)
}

export function deleteBucketLifecycle(ctx, res, { store }) {
  store.deleteBucketConfig(ctx.bucket, 'lifecycle')
  sendEmpty(ctx, res, 204)
}

/* ------------------------------ tagging ------------------------------- */

export function getBucketTagging(ctx, res, { store }) {
  const tags = store.getBucketConfig(ctx.bucket, 'tagging')
  if (!tags || Object.keys(tags).length === 0) throw new S3Error('NoSuchTagSet')
  sendXml(ctx, res, 200, taggingXml(tags))
}

export async function putBucketTagging(ctx, res, { store }) {
  store.requireBucket(ctx.bucket)
  const tags = parseTaggingXml(await collectBody(ctx.bodyStreams), { max: MAX_BUCKET_TAGS })
  store.putBucketConfig(ctx.bucket, 'tagging', tags)
  sendEmpty(ctx, res, 204)
}

export function deleteBucketTagging(ctx, res, { store }) {
  store.deleteBucketConfig(ctx.bucket, 'tagging')
  sendEmpty(ctx, res, 204)
}

/* --------------------------- notifications ---------------------------- */

export function getBucketNotification(ctx, res, { store }) {
  const config = store.getBucketConfig(ctx.bucket, 'notification')
  sendXml(ctx, res, 200, notificationXml(config ?? { targets: [] }))
}

export async function putBucketNotification(ctx, res, { store }) {
  store.requireBucket(ctx.bucket)
  const config = parseNotificationXml(await collectBody(ctx.bodyStreams))
  if (config.targets.length === 0) {
    store.deleteBucketConfig(ctx.bucket, 'notification')
  } else {
    store.putBucketConfig(ctx.bucket, 'notification', config)
  }
  sendEmpty(ctx, res, 200)
}
