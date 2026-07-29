import type { ServerResponse } from 'node:http'
import { S3Error } from './errors.js'
import * as handlers from './handlers/index.js'
import { bucketArn, objectArn } from './features/policy.js'
import type { RequestContext } from './http.js'
import type { ObjectStore } from './storage/store.js'
import type { S3NodeServer } from './server.js'

type HandlerFn = (ctx: RequestContext, res: ServerResponse, deps: { store: ObjectStore; server: S3NodeServer }) => void | Promise<void>

const NOT_IMPLEMENTED_SUBRESOURCES = [
  'acl', 'website', 'replication', 'encryption', 'accelerate',
  'logging', 'requestPayment', 'analytics', 'inventory', 'metrics', 'publicAccessBlock',
  'intelligent-tiering', 'ownershipControls', 'restore', 'select',
]

function rejectUnimplemented(ctx: RequestContext): void {
  for (const subresource of NOT_IMPLEMENTED_SUBRESOURCES) {
    if (ctx.query.has(subresource)) {
      throw new S3Error('NotImplemented', `The ${subresource} subresource is not implemented`)
    }
  }
}

interface Route {
  handler: HandlerFn
  action: string
  resource?: string
  /**
   * The handler carries out its own authentication and authorization, so the
   * server must not run the standard SigV4 path first. Only browser-based POST
   * uploads qualify: their credentials live in the form policy, which cannot be
   * read until the multipart body has been parsed.
   */
  selfAuthenticating?: boolean
}

const route = (handler: HandlerFn, action: string, options: { selfAuthenticating?: boolean } = {}): Route =>
  ({ handler, action, ...options })

function bucketRoute(ctx: RequestContext): Route {
  const { method, query } = ctx

  if (method === 'PUT') {
    if (query.has('versioning')) return route(handlers.putBucketVersioning as HandlerFn, 's3:PutBucketVersioning')
    if (query.has('policy')) return route(handlers.putBucketPolicy as HandlerFn, 's3:PutBucketPolicy')
    if (query.has('cors')) return route(handlers.putBucketCors as HandlerFn, 's3:PutBucketCORS')
    if (query.has('lifecycle')) return route(handlers.putBucketLifecycle as HandlerFn, 's3:PutLifecycleConfiguration')
    if (query.has('tagging')) return route(handlers.putBucketTagging as HandlerFn, 's3:PutBucketTagging')
    if (query.has('notification')) return route(handlers.putBucketNotification as HandlerFn, 's3:PutBucketNotification')
    if (query.has('object-lock')) return route(handlers.putBucketObjectLock as HandlerFn, 's3:PutBucketObjectLockConfiguration')
    return route(handlers.createBucket as HandlerFn, 's3:CreateBucket')
  }

  if (method === 'DELETE') {
    if (query.has('policy')) return route(handlers.deleteBucketPolicy as HandlerFn, 's3:DeleteBucketPolicy')
    if (query.has('cors')) return route(handlers.deleteBucketCors as HandlerFn, 's3:PutBucketCORS')
    if (query.has('lifecycle')) return route(handlers.deleteBucketLifecycle as HandlerFn, 's3:PutLifecycleConfiguration')
    if (query.has('tagging')) return route(handlers.deleteBucketTagging as HandlerFn, 's3:PutBucketTagging')
    return route(handlers.deleteBucket as HandlerFn, 's3:DeleteBucket')
  }

  if (method === 'HEAD') return route(handlers.headBucket as HandlerFn, 's3:ListBucket')

  if (method === 'POST') {
    if (query.has('delete')) return route(handlers.deleteObjects as HandlerFn, 's3:DeleteObject')
    return route(handlers.postObject as HandlerFn, 's3:PutObject', { selfAuthenticating: true })
  }

  if (method === 'GET') {
    if (query.has('location')) return route(handlers.getBucketLocation as HandlerFn, 's3:GetBucketLocation')
    if (query.has('versioning')) return route(handlers.getBucketVersioning as HandlerFn, 's3:GetBucketVersioning')
    if (query.has('policy')) return route(handlers.getBucketPolicy as HandlerFn, 's3:GetBucketPolicy')
    if (query.has('cors')) return route(handlers.getBucketCors as HandlerFn, 's3:GetBucketCORS')
    if (query.has('lifecycle')) return route(handlers.getBucketLifecycle as HandlerFn, 's3:GetLifecycleConfiguration')
    if (query.has('tagging')) return route(handlers.getBucketTagging as HandlerFn, 's3:GetBucketTagging')
    if (query.has('notification')) return route(handlers.getBucketNotification as HandlerFn, 's3:GetBucketNotification')
    if (query.has('object-lock')) return route(handlers.getBucketObjectLock as HandlerFn, 's3:GetBucketObjectLockConfiguration')
    if (query.has('versions')) return route(handlers.listObjectVersions as HandlerFn, 's3:ListBucketVersions')
    if (query.has('uploads')) return route(handlers.listMultipartUploads as HandlerFn, 's3:ListBucketMultipartUploads')
    return query.get('list-type') === '2'
      ? route(handlers.listObjectsV2 as HandlerFn, 's3:ListBucket')
      : route(handlers.listObjectsV1 as HandlerFn, 's3:ListBucket')
  }

  throw new S3Error('MethodNotAllowed')
}

function objectRoute(ctx: RequestContext): Route {
  const { method, query, headers } = ctx
  const uploadId = query.get('uploadId')

  if (method === 'PUT') {
    if (query.has('tagging')) return route(handlers.putObjectTagging as HandlerFn, 's3:PutObjectTagging')
    if (query.has('retention')) return route(handlers.putObjectRetention as HandlerFn, 's3:PutObjectRetention')
    if (query.has('legal-hold')) return route(handlers.putObjectLegalHold as HandlerFn, 's3:PutObjectLegalHold')
    if (uploadId && query.has('partNumber')) {
      // UploadPartCopy is UploadPart plus a copy source; the source object is
      // read server-side, so the caller also needs GetObject on it.
      return headers['x-amz-copy-source']
        ? route(handlers.uploadPartCopy as HandlerFn, 's3:PutObject')
        : route(handlers.uploadPart as HandlerFn, 's3:PutObject')
    }
    if (headers['x-amz-copy-source']) return route(handlers.copyObject as HandlerFn, 's3:PutObject')
    return route(handlers.putObject as HandlerFn, 's3:PutObject')
  }

  if (method === 'POST') {
    if (query.has('uploads')) return route(handlers.createMultipartUpload as HandlerFn, 's3:PutObject')
    if (uploadId) return route(handlers.completeMultipartUpload as HandlerFn, 's3:PutObject')
    throw new S3Error('MethodNotAllowed')
  }

  if (method === 'GET') {
    if (query.has('tagging')) return route(handlers.getObjectTagging as HandlerFn, 's3:GetObjectTagging')
    if (query.has('retention')) return route(handlers.getObjectRetention as HandlerFn, 's3:GetObjectRetention')
    if (query.has('legal-hold')) return route(handlers.getObjectLegalHold as HandlerFn, 's3:GetObjectLegalHold')
    if (uploadId) return route(handlers.listParts as HandlerFn, 's3:ListMultipartUploadParts')
    return route(handlers.getObject as HandlerFn, 's3:GetObject')
  }

  if (method === 'HEAD') return route(handlers.headObject as HandlerFn, 's3:GetObject')

  if (method === 'DELETE') {
    if (query.has('tagging')) return route(handlers.deleteObjectTagging as HandlerFn, 's3:DeleteObjectTagging')
    if (uploadId) return route(handlers.abortMultipartUpload as HandlerFn, 's3:AbortMultipartUpload')
    return route(handlers.deleteObject as HandlerFn, 's3:DeleteObject')
  }

  throw new S3Error('MethodNotAllowed')
}

export function resolveRoute(ctx: RequestContext): Route & { resource: string } {
  if (!ctx.bucket) {
    if (ctx.method === 'GET') {
      return { ...route(handlers.listBuckets as HandlerFn, 's3:ListAllMyBuckets'), resource: 'arn:aws:s3:::*' }
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
