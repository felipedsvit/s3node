import { S3Error } from './errors.js'
import * as handlers from './handlers.js'

const NOT_IMPLEMENTED_SUBRESOURCES = [
  'acl', 'cors', 'lifecycle', 'policy', 'tagging', 'website',
  'replication', 'encryption', 'notification', 'object-lock', 'accelerate',
  'logging', 'requestPayment', 'analytics', 'inventory', 'metrics', 'publicAccessBlock',
]

function rejectUnimplemented(ctx) {
  for (const subresource of NOT_IMPLEMENTED_SUBRESOURCES) {
    if (ctx.query.has(subresource)) {
      throw new S3Error('NotImplemented', `The ${subresource} subresource is not implemented`)
    }
  }
}

/**
 * S3 routing is unusual: sub-resources arrive as query-string flags rather than
 * path segments, so dispatch is a decision tree rather than a path table
 * (docs/plan.md section 8).
 */
export function resolveHandler(ctx) {
  const { method, bucket, key, query } = ctx

  if (!bucket) {
    if (method === 'GET') return handlers.listBuckets
    throw new S3Error('MethodNotAllowed')
  }

  if (!key) {
    rejectUnimplemented(ctx)
    switch (method) {
      case 'PUT': return handlers.createBucket
      case 'DELETE': return handlers.deleteBucket
      case 'HEAD': return handlers.headBucket
      case 'POST':
        if (query.has('delete')) return handlers.deleteObjects
        throw new S3Error('MethodNotAllowed')
      case 'GET':
        if (query.has('location')) return handlers.getBucketLocation
        if (query.has('versioning')) return handlers.getBucketVersioning
        if (query.has('uploads')) return handlers.listMultipartUploads
        return query.get('list-type') === '2' ? handlers.listObjectsV2 : handlers.listObjectsV1
      default:
        throw new S3Error('MethodNotAllowed')
    }
  }

  rejectUnimplemented(ctx)
  const uploadId = query.get('uploadId')

  switch (method) {
    case 'PUT':
      if (uploadId && query.has('partNumber')) return handlers.uploadPart
      if (ctx.headers['x-amz-copy-source']) return handlers.copyObject
      return handlers.putObject
    case 'POST':
      if (query.has('uploads')) return handlers.createMultipartUpload
      if (uploadId) return handlers.completeMultipartUpload
      throw new S3Error('MethodNotAllowed')
    case 'GET':
      if (uploadId) return handlers.listParts
      return handlers.getObject
    case 'HEAD':
      return handlers.headObject
    case 'DELETE':
      if (uploadId) return handlers.abortMultipartUpload
      return handlers.deleteObject
    default:
      throw new S3Error('MethodNotAllowed')
  }
}
