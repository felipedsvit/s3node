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
    // The server skips its SigV4 check for this route, so the flag has to be
    // carried by the Route itself — never inferred from the handler's name,
    // which any rename or minifier would silently invalidate.
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
})
