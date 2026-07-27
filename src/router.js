import { S3Error } from './errors.js'
import * as handlers from './handlers/index.js'
import { bucketArn, objectArn } from './features/policy.js'

/**
 * Sub-resources that are recognised but not implemented. Returning
 * NotImplemented is deliberate: silently succeeding would let a client believe
 * an ACL or a replication rule had been applied.
 */
const NOT_IMPLEMENTED_SUBRESOURCES = [
  'acl', 'website', 'replication', 'encryption', 'object-lock', 'accelerate',
  'logging', 'requestPayment', 'analytics', 'inventory', 'metrics', 'publicAccessBlock',
  'intelligent-tiering', 'ownershipControls', 'legal-hold', 'retention', 'restore', 'select',
]

function rejectUnimplemented(ctx) {
  for (const subresource of NOT_IMPLEMENTED_SUBRESOURCES) {
    if (ctx.query.has(subresource)) {
      throw new S3Error('NotImplemented', `The ${subresource} subresource is not implemented`)
    }
  }
}

const route = (handler, action) => ({ handler, action })

function bucketRoute(ctx) {
  const { method, query } = ctx

  if (method === 'PUT') {
    if (query.has('versioning')) return route(handlers.putBucketVersioning, 's3:PutBucketVersioning')
    if (query.has('policy')) return route(handlers.putBucketPolicy, 's3:PutBucketPolicy')
    if (query.has('cors')) return route(handlers.putBucketCors, 's3:PutBucketCORS')
    if (query.has('lifecycle')) return route(handlers.putBucketLifecycle, 's3:PutLifecycleConfiguration')
    if (query.has('tagging')) return route(handlers.putBucketTagging, 's3:PutBucketTagging')
    if (query.has('notification')) return route(handlers.putBucketNotification, 's3:PutBucketNotification')
    return route(handlers.createBucket, 's3:CreateBucket')
  }

  if (method === 'DELETE') {
    if (query.has('policy')) return route(handlers.deleteBucketPolicy, 's3:DeleteBucketPolicy')
    if (query.has('cors')) return route(handlers.deleteBucketCors, 's3:PutBucketCORS')
    if (query.has('lifecycle')) return route(handlers.deleteBucketLifecycle, 's3:PutLifecycleConfiguration')
    if (query.has('tagging')) return route(handlers.deleteBucketTagging, 's3:PutBucketTagging')
    return route(handlers.deleteBucket, 's3:DeleteBucket')
  }

  if (method === 'HEAD') return route(handlers.headBucket, 's3:ListBucket')

  if (method === 'POST') {
    if (query.has('delete')) return route(handlers.deleteObjects, 's3:DeleteObject')
    return route(handlers.postObject, 's3:PutObject')
  }

  if (method === 'GET') {
    if (query.has('location')) return route(handlers.getBucketLocation, 's3:GetBucketLocation')
    if (query.has('versioning')) return route(handlers.getBucketVersioning, 's3:GetBucketVersioning')
    if (query.has('policy')) return route(handlers.getBucketPolicy, 's3:GetBucketPolicy')
    if (query.has('cors')) return route(handlers.getBucketCors, 's3:GetBucketCORS')
    if (query.has('lifecycle')) return route(handlers.getBucketLifecycle, 's3:GetLifecycleConfiguration')
    if (query.has('tagging')) return route(handlers.getBucketTagging, 's3:GetBucketTagging')
    if (query.has('notification')) return route(handlers.getBucketNotification, 's3:GetBucketNotification')
    if (query.has('versions')) return route(handlers.listObjectVersions, 's3:ListBucketVersions')
    if (query.has('uploads')) return route(handlers.listMultipartUploads, 's3:ListBucketMultipartUploads')
    return query.get('list-type') === '2'
      ? route(handlers.listObjectsV2, 's3:ListBucket')
      : route(handlers.listObjectsV1, 's3:ListBucket')
  }

  throw new S3Error('MethodNotAllowed')
}

function objectRoute(ctx) {
  const { method, query, headers } = ctx
  const uploadId = query.get('uploadId')

  if (method === 'PUT') {
    if (query.has('tagging')) return route(handlers.putObjectTagging, 's3:PutObjectTagging')
    if (uploadId && query.has('partNumber')) return route(handlers.uploadPart, 's3:PutObject')
    if (headers['x-amz-copy-source']) return route(handlers.copyObject, 's3:PutObject')
    return route(handlers.putObject, 's3:PutObject')
  }

  if (method === 'POST') {
    if (query.has('uploads')) return route(handlers.createMultipartUpload, 's3:PutObject')
    if (uploadId) return route(handlers.completeMultipartUpload, 's3:PutObject')
    throw new S3Error('MethodNotAllowed')
  }

  if (method === 'GET') {
    if (query.has('tagging')) return route(handlers.getObjectTagging, 's3:GetObjectTagging')
    if (uploadId) return route(handlers.listParts, 's3:ListMultipartUploadParts')
    return route(handlers.getObject, 's3:GetObject')
  }

  if (method === 'HEAD') return route(handlers.headObject, 's3:GetObject')

  if (method === 'DELETE') {
    if (query.has('tagging')) return route(handlers.deleteObjectTagging, 's3:DeleteObjectTagging')
    if (uploadId) return route(handlers.abortMultipartUpload, 's3:AbortMultipartUpload')
    return route(handlers.deleteObject, 's3:DeleteObject')
  }

  throw new S3Error('MethodNotAllowed')
}

/**
 * S3 routing is unusual: sub-resources arrive as query-string flags rather than
 * path segments, so dispatch is a decision tree rather than a path table
 * (docs/plan.md section 8).
 *
 * Returns the handler alongside the IAM action it performs and the ARN it acts
 * on, which is what bucket-policy evaluation needs.
 */
export function resolveRoute(ctx) {
  if (!ctx.bucket) {
    if (ctx.method === 'GET') {
      return { ...route(handlers.listBuckets, 's3:ListAllMyBuckets'), resource: 'arn:aws:s3:::*' }
    }
    throw new S3Error('MethodNotAllowed')
  }

  rejectUnimplemented(ctx)
  const resolved = ctx.key ? objectRoute(ctx) : bucketRoute(ctx)
  return {
    ...resolved,
    resource: ctx.key ? objectArn(ctx.bucket, ctx.key) : bucketArn(ctx.bucket),
  }
}
