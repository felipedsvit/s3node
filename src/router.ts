import type { ServerResponse } from 'node:http'
import { S3Error } from './errors.js'
import * as handlers from './handlers/index.js'
import { bucketArn, objectArn } from './features/policy.js'
import type { RequestContext } from './http.js'
import type { ObjectStore } from './storage/store.js'
import type { S3NodeServer } from './server.js'

type HandlerFn = (ctx: RequestContext, res: ServerResponse, deps: { store: ObjectStore; server: S3NodeServer }) => void | Promise<void>

type Matcher = (ctx: RequestContext) => boolean

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

// ── Matcher helpers ──────────────────────────────────────────────────

const method = (m: string): Matcher => (ctx) => ctx.method === m

const hasQuery = (name: string): Matcher => (ctx) => ctx.query.has(name)

const hasQueryVal = (name: string, val: string): Matcher => (ctx) => ctx.query.get(name) === val

const hasTruthy = (name: string): Matcher => (ctx) => !!ctx.query.get(name)

const hasHeader = (name: string): Matcher => (ctx) => ctx.headers[name] !== undefined

const isBucketOp: Matcher = (ctx) => !!ctx.bucket && !ctx.key

const isObjectOp: Matcher = (ctx) => !!ctx.bucket && !!ctx.key

const noBucket: Matcher = (ctx) => !ctx.bucket

const and = (...fns: Matcher[]): Matcher => (ctx) => {
  for (const fn of fns) if (!fn(ctx)) return false
  return true
}

// ── Route entries ────────────────────────────────────────────────────

interface RouteDef {
  methods: string[]
  matcher: Matcher
  handler: HandlerFn
  action: string
  selfAuthenticating?: boolean
  /** Only set for routes where ctx.bucket is empty (e.g. ListBuckets). */
  fixedResource?: string
}

const ROUTES: RouteDef[] = [
  /* Service-level — no bucket */
  { methods: ['GET'],         matcher: noBucket,                                  handler: handlers.listBuckets as HandlerFn,          action: 's3:ListAllMyBuckets',    fixedResource: 'arn:aws:s3:::*' },

  /* ── Bucket-level ─────────────────────────────────────────────── */

  /* PUT */
  { methods: ['PUT'],         matcher: and(isBucketOp, hasQuery('versioning')),   handler: handlers.putBucketVersioning as HandlerFn,  action: 's3:PutBucketVersioning' },
  { methods: ['PUT'],         matcher: and(isBucketOp, hasQuery('policy')),       handler: handlers.putBucketPolicy as HandlerFn,      action: 's3:PutBucketPolicy' },
  { methods: ['PUT'],         matcher: and(isBucketOp, hasQuery('cors')),         handler: handlers.putBucketCors as HandlerFn,        action: 's3:PutBucketCORS' },
  { methods: ['PUT'],         matcher: and(isBucketOp, hasQuery('lifecycle')),    handler: handlers.putBucketLifecycle as HandlerFn,   action: 's3:PutLifecycleConfiguration' },
  { methods: ['PUT'],         matcher: and(isBucketOp, hasQuery('tagging')),      handler: handlers.putBucketTagging as HandlerFn,     action: 's3:PutBucketTagging' },
  { methods: ['PUT'],         matcher: and(isBucketOp, hasQuery('notification')), handler: handlers.putBucketNotification as HandlerFn,action: 's3:PutBucketNotification' },
  { methods: ['PUT'],         matcher: and(isBucketOp, hasQuery('object-lock')),  handler: handlers.putBucketObjectLock as HandlerFn,  action: 's3:PutBucketObjectLockConfiguration' },
  { methods: ['PUT'],         matcher: isBucketOp,                                handler: handlers.createBucket as HandlerFn,         action: 's3:CreateBucket' },

  /* DELETE */
  { methods: ['DELETE'],      matcher: and(isBucketOp, hasQuery('policy')),       handler: handlers.deleteBucketPolicy as HandlerFn,   action: 's3:DeleteBucketPolicy' },
  { methods: ['DELETE'],      matcher: and(isBucketOp, hasQuery('cors')),         handler: handlers.deleteBucketCors as HandlerFn,     action: 's3:PutBucketCORS' },
  { methods: ['DELETE'],      matcher: and(isBucketOp, hasQuery('lifecycle')),    handler: handlers.deleteBucketLifecycle as HandlerFn,action: 's3:PutLifecycleConfiguration' },
  { methods: ['DELETE'],      matcher: and(isBucketOp, hasQuery('tagging')),      handler: handlers.deleteBucketTagging as HandlerFn,  action: 's3:PutBucketTagging' },
  { methods: ['DELETE'],      matcher: isBucketOp,                                handler: handlers.deleteBucket as HandlerFn,         action: 's3:DeleteBucket' },

  /* HEAD */
  { methods: ['HEAD'],        matcher: isBucketOp,                                handler: handlers.headBucket as HandlerFn,           action: 's3:ListBucket' },

  /* POST */
  { methods: ['POST'],        matcher: and(isBucketOp, hasQuery('delete')),       handler: handlers.deleteObjects as HandlerFn,        action: 's3:DeleteObject' },
  { methods: ['POST'],        matcher: isBucketOp,                                handler: handlers.postObject as HandlerFn,           action: 's3:PutObject',           selfAuthenticating: true },

  /* GET */
  { methods: ['GET'],         matcher: and(isBucketOp, hasQuery('location')),     handler: handlers.getBucketLocation as HandlerFn,    action: 's3:GetBucketLocation' },
  { methods: ['GET'],         matcher: and(isBucketOp, hasQuery('versioning')),   handler: handlers.getBucketVersioning as HandlerFn,  action: 's3:GetBucketVersioning' },
  { methods: ['GET'],         matcher: and(isBucketOp, hasQuery('policy')),       handler: handlers.getBucketPolicy as HandlerFn,      action: 's3:GetBucketPolicy' },
  { methods: ['GET'],         matcher: and(isBucketOp, hasQuery('cors')),         handler: handlers.getBucketCors as HandlerFn,        action: 's3:GetBucketCORS' },
  { methods: ['GET'],         matcher: and(isBucketOp, hasQuery('lifecycle')),    handler: handlers.getBucketLifecycle as HandlerFn,   action: 's3:GetLifecycleConfiguration' },
  { methods: ['GET'],         matcher: and(isBucketOp, hasQuery('tagging')),      handler: handlers.getBucketTagging as HandlerFn,     action: 's3:GetBucketTagging' },
  { methods: ['GET'],         matcher: and(isBucketOp, hasQuery('notification')), handler: handlers.getBucketNotification as HandlerFn,action: 's3:GetBucketNotification' },
  { methods: ['GET'],         matcher: and(isBucketOp, hasQuery('object-lock')),  handler: handlers.getBucketObjectLock as HandlerFn,  action: 's3:GetBucketObjectLockConfiguration' },
  { methods: ['GET'],         matcher: and(isBucketOp, hasQuery('versions')),     handler: handlers.listObjectVersions as HandlerFn,   action: 's3:ListBucketVersions' },
  { methods: ['GET'],         matcher: and(isBucketOp, hasQuery('uploads')),      handler: handlers.listMultipartUploads as HandlerFn, action: 's3:ListBucketMultipartUploads' },
  { methods: ['GET'],         matcher: and(isBucketOp, hasQueryVal('list-type', '2')), handler: handlers.listObjectsV2 as HandlerFn,  action: 's3:ListBucket' },
  { methods: ['GET'],         matcher: isBucketOp,                                handler: handlers.listObjectsV1 as HandlerFn,       action: 's3:ListBucket' },

  /* ── Object-level ──────────────────────────────────────────────── */

  /* PUT */
  { methods: ['PUT'],         matcher: and(isObjectOp, hasQuery('tagging')),      handler: handlers.putObjectTagging as HandlerFn,     action: 's3:PutObjectTagging' },
  { methods: ['PUT'],         matcher: and(isObjectOp, hasQuery('retention')),    handler: handlers.putObjectRetention as HandlerFn,   action: 's3:PutObjectRetention' },
  { methods: ['PUT'],         matcher: and(isObjectOp, hasQuery('legal-hold')),   handler: handlers.putObjectLegalHold as HandlerFn,   action: 's3:PutObjectLegalHold' },
  { methods: ['PUT'],         matcher: and(isObjectOp, hasTruthy('uploadId'), hasQuery('partNumber'), hasHeader('x-amz-copy-source')), handler: handlers.uploadPartCopy as HandlerFn, action: 's3:PutObject' },
  { methods: ['PUT'],         matcher: and(isObjectOp, hasTruthy('uploadId'), hasQuery('partNumber')), handler: handlers.uploadPart as HandlerFn, action: 's3:PutObject' },
  { methods: ['PUT'],         matcher: and(isObjectOp, hasHeader('x-amz-copy-source')), handler: handlers.copyObject as HandlerFn, action: 's3:PutObject' },
  { methods: ['PUT'],         matcher: isObjectOp,                                handler: handlers.putObject as HandlerFn,           action: 's3:PutObject' },

  /* POST */
  { methods: ['POST'],        matcher: and(isObjectOp, hasQuery('uploads')),      handler: handlers.createMultipartUpload as HandlerFn,action: 's3:PutObject' },
  { methods: ['POST'],        matcher: and(isObjectOp, hasTruthy('uploadId')),    handler: handlers.completeMultipartUpload as HandlerFn, action: 's3:PutObject' },

  /* GET */
  { methods: ['GET'],         matcher: and(isObjectOp, hasQuery('tagging')),      handler: handlers.getObjectTagging as HandlerFn,     action: 's3:GetObjectTagging' },
  { methods: ['GET'],         matcher: and(isObjectOp, hasQuery('retention')),    handler: handlers.getObjectRetention as HandlerFn,   action: 's3:GetObjectRetention' },
  { methods: ['GET'],         matcher: and(isObjectOp, hasQuery('legal-hold')),   handler: handlers.getObjectLegalHold as HandlerFn,   action: 's3:GetObjectLegalHold' },
  { methods: ['GET'],         matcher: and(isObjectOp, hasTruthy('uploadId')),    handler: handlers.listParts as HandlerFn,            action: 's3:ListMultipartUploadParts' },
  { methods: ['GET'],         matcher: isObjectOp,                                handler: handlers.getObject as HandlerFn,            action: 's3:GetObject' },

  /* HEAD */
  { methods: ['HEAD'],        matcher: isObjectOp,                                handler: handlers.headObject as HandlerFn,           action: 's3:GetObject' },

  /* DELETE */
  { methods: ['DELETE'],      matcher: and(isObjectOp, hasQuery('tagging')),      handler: handlers.deleteObjectTagging as HandlerFn,  action: 's3:DeleteObjectTagging' },
  { methods: ['DELETE'],      matcher: and(isObjectOp, hasTruthy('uploadId')),    handler: handlers.abortMultipartUpload as HandlerFn, action: 's3:AbortMultipartUpload' },
  { methods: ['DELETE'],      matcher: isObjectOp,                                handler: handlers.deleteObject as HandlerFn,         action: 's3:DeleteObject' },
]

// ── Resolution ──────────────────────────────────────────────────────

interface Route {
  handler: HandlerFn
  action: string
  resource?: string
  selfAuthenticating?: boolean | undefined
}

export function resolveRoute(ctx: RequestContext): Route & { resource: string } {
  /* Service-level: no bucket — only ListBuckets is valid. */
  if (!ctx.bucket) {
    if (ctx.method === 'GET') {
      return { handler: handlers.listBuckets as HandlerFn, action: 's3:ListAllMyBuckets', resource: 'arn:aws:s3:::*' }
    }
    throw new S3Error('MethodNotAllowed')
  }

  rejectUnimplemented(ctx)

  for (const def of ROUTES) {
    if (!def.methods.includes(ctx.method!)) continue
    if (!def.matcher(ctx)) continue
    const resource = def.fixedResource ?? (ctx.key ? objectArn(ctx.bucket, ctx.key) : bucketArn(ctx.bucket))
    return { handler: def.handler, action: def.action, resource, selfAuthenticating: def.selfAuthenticating }
  }

  throw new S3Error('MethodNotAllowed')
}
