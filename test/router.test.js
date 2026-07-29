import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createContext } from '../dist/src/http.js'
import { resolveRoute } from '../dist/src/router.js'

/** Minimal stand-in for an IncomingMessage, enough for createContext. */
function contextFor(method, url, headers = {}) {
  return createContext({ method, url, headers: { host: 'localhost', ...headers } })
}

describe('route resolution', () => {
  it('marks only the browser POST upload as self-authenticating', () => {
    const post = resolveRoute(contextFor('POST', '/bucket'))
    assert.equal(post.selfAuthenticating, true)

    for (const [method, url] of [
      ['PUT', '/bucket/key'],
      ['GET', '/bucket/key'],
      ['DELETE', '/bucket/key'],
      ['POST', '/bucket?delete='],
      ['POST', '/bucket/key?uploads='],
      ['GET', '/bucket'],
      ['PUT', '/bucket'],
    ]) {
      const route = resolveRoute(contextFor(method, url))
      assert.notEqual(route.selfAuthenticating, true, `${method} ${url} must not skip authentication`)
    }
  })

  it('resolves the resource ARN from the target', () => {
    assert.equal(resolveRoute(contextFor('GET', '/bucket/a/b.txt')).resource, 'arn:aws:s3:::bucket/a/b.txt')
    assert.equal(resolveRoute(contextFor('GET', '/bucket')).resource, 'arn:aws:s3:::bucket')
    assert.equal(resolveRoute(contextFor('GET', '/')).resource, 'arn:aws:s3:::*')
  })

  it('rejects subresources that are not implemented', () => {
    assert.throws(
      () => resolveRoute(contextFor('GET', '/bucket?acl=')),
      (err) => err.code === 'NotImplemented',
    )
  })

  it('resolves bucket subresource routes by priority', () => {
    // PUT bucket subresources — each must resolve to the correct handler action.
    const subresourceTests = [
      ['PUT', '/bucket?versioning=', 's3:PutBucketVersioning'],
      ['PUT', '/bucket?policy=', 's3:PutBucketPolicy'],
      ['PUT', '/bucket?cors=', 's3:PutBucketCORS'],
      ['PUT', '/bucket?lifecycle=', 's3:PutLifecycleConfiguration'],
      ['PUT', '/bucket?tagging=', 's3:PutBucketTagging'],
      ['PUT', '/bucket?notification=', 's3:PutBucketNotification'],
      ['PUT', '/bucket?object-lock=', 's3:PutBucketObjectLockConfiguration'],
      ['GET', '/bucket?location=', 's3:GetBucketLocation'],
      ['GET', '/bucket?versioning=', 's3:GetBucketVersioning'],
      ['GET', '/bucket?policy=', 's3:GetBucketPolicy'],
      ['GET', '/bucket?cors=', 's3:GetBucketCORS'],
      ['GET', '/bucket?lifecycle=', 's3:GetLifecycleConfiguration'],
      ['GET', '/bucket?tagging=', 's3:GetBucketTagging'],
      ['GET', '/bucket?notification=', 's3:GetBucketNotification'],
      ['GET', '/bucket?object-lock=', 's3:GetBucketObjectLockConfiguration'],
      ['GET', '/bucket?versions=', 's3:ListBucketVersions'],
      ['GET', '/bucket?uploads=', 's3:ListBucketMultipartUploads'],
      ['DELETE', '/bucket?policy=', 's3:DeleteBucketPolicy'],
      ['DELETE', '/bucket?cors=', 's3:PutBucketCORS'],
      ['DELETE', '/bucket?lifecycle=', 's3:PutLifecycleConfiguration'],
      ['DELETE', '/bucket?tagging=', 's3:PutBucketTagging'],
    ]
    for (const [method, url, expectedAction] of subresourceTests) {
      const route = resolveRoute(contextFor(method, url))
      assert.equal(route.action, expectedAction, `${method} ${url}`)
    }
  })

  it('resolves object subresource routes by priority', () => {
    const subresourceTests = [
      ['PUT', '/bucket/key?tagging=', 's3:PutObjectTagging'],
      ['PUT', '/bucket/key?retention=', 's3:PutObjectRetention'],
      ['PUT', '/bucket/key?legal-hold=', 's3:PutObjectLegalHold'],
      ['GET', '/bucket/key?tagging=', 's3:GetObjectTagging'],
      ['GET', '/bucket/key?retention=', 's3:GetObjectRetention'],
      ['GET', '/bucket/key?legal-hold=', 's3:GetObjectLegalHold'],
      ['DELETE', '/bucket/key?tagging=', 's3:DeleteObjectTagging'],
    ]
    for (const [method, url, expectedAction] of subresourceTests) {
      const route = resolveRoute(contextFor(method, url))
      assert.equal(route.action, expectedAction, `${method} ${url}`)
    }
  })

  it('resolves object default routes', () => {
    assert.equal(resolveRoute(contextFor('PUT', '/bucket/key')).action, 's3:PutObject')
    assert.equal(resolveRoute(contextFor('GET', '/bucket/key')).action, 's3:GetObject')
    assert.equal(resolveRoute(contextFor('HEAD', '/bucket/key')).action, 's3:GetObject')
    assert.equal(resolveRoute(contextFor('DELETE', '/bucket/key')).action, 's3:DeleteObject')
  })

  it('resolves bucket default routes', () => {
    assert.equal(resolveRoute(contextFor('PUT', '/bucket')).action, 's3:CreateBucket')
    assert.equal(resolveRoute(contextFor('DELETE', '/bucket')).action, 's3:DeleteBucket')
    assert.equal(resolveRoute(contextFor('HEAD', '/bucket')).action, 's3:ListBucket')
    assert.equal(resolveRoute(contextFor('GET', '/bucket')).action, 's3:ListBucket')
  })

  it('resolves multipart upload routes', () => {
    // CreateMultipartUpload: POST /bucket/key?uploads=
    assert.equal(resolveRoute(contextFor('POST', '/bucket/key?uploads=')).action, 's3:PutObject')

    // CompleteMultipartUpload: POST /bucket/key?uploadId=xxx
    assert.equal(resolveRoute(contextFor('POST', '/bucket/key?uploadId=xxx')).action, 's3:PutObject')

    // UploadPart: PUT /bucket/key?uploadId=xxx&partNumber=1
    assert.equal(resolveRoute(contextFor('PUT', '/bucket/key?uploadId=xxx&partNumber=1')).action, 's3:PutObject')

    // UploadPartCopy: PUT /bucket/key?uploadId=xxx&partNumber=1 + x-amz-copy-source header
    const copyRoute = resolveRoute(contextFor('PUT', '/bucket/key?uploadId=xxx&partNumber=1', { 'x-amz-copy-source': '/src-bucket/src-key' }))
    assert.equal(copyRoute.action, 's3:PutObject')

    // ListParts: GET /bucket/key?uploadId=xxx
    assert.equal(resolveRoute(contextFor('GET', '/bucket/key?uploadId=xxx')).action, 's3:ListMultipartUploadParts')

    // AbortMultipartUpload: DELETE /bucket/key?uploadId=xxx
    assert.equal(resolveRoute(contextFor('DELETE', '/bucket/key?uploadId=xxx')).action, 's3:AbortMultipartUpload')

    // ListMultipartUploads: GET /bucket?uploads=
    assert.equal(resolveRoute(contextFor('GET', '/bucket?uploads=')).action, 's3:ListBucketMultipartUploads')
  })

  it('resolves ListObjectsV2 vs V1 based on list-type', () => {
    // V2
    assert.equal(resolveRoute(contextFor('GET', '/bucket?list-type=2')).action, 's3:ListBucket')
    // V1 (default)
    assert.equal(resolveRoute(contextFor('GET', '/bucket')).action, 's3:ListBucket')
  })

  it('resolves delete objects via POST', () => {
    const route = resolveRoute(contextFor('POST', '/bucket?delete='))
    assert.equal(route.action, 's3:DeleteObject')
  })

  it('rejects unsupported methods', () => {
    assert.throws(() => resolveRoute(contextFor('PATCH', '/bucket')), (err) => err.code === 'MethodNotAllowed')
    assert.throws(() => resolveRoute(contextFor('PATCH', '/bucket/key')), (err) => err.code === 'MethodNotAllowed')
    assert.throws(() => resolveRoute(contextFor('POST', '/')), (err) => err.code === 'MethodNotAllowed')
    assert.throws(() => resolveRoute(contextFor('PUT', '/')), (err) => err.code === 'MethodNotAllowed')
  })
})
