import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import { evaluatePolicy, ipInCidr, parsePolicy } from '../dist/src/features/policy.js'
import { allTags, startServer, tag } from './helpers/harness.js'

const BUCKET = 'policy-bucket'

const target = (overrides = {}) => ({
  action: 's3:GetObject',
  resource: `arn:aws:s3:::${BUCKET}/public/file.txt`,
  context: { principal: '*' },
  ...overrides,
})

describe('policy engine', () => {
  it('returns NoDecision when no statement matches', () => {
    const policy = parsePolicy(JSON.stringify({
      Statement: [{ Effect: 'Allow', Principal: '*', Action: 's3:PutObject', Resource: '*' }],
    }))
    assert.equal(evaluatePolicy(policy, target()), 'NoDecision')
  })

  it('allows a matching statement', () => {
    const policy = parsePolicy(JSON.stringify({
      Statement: [{
        Effect: 'Allow', Principal: '*', Action: 's3:GetObject',
        Resource: `arn:aws:s3:::${BUCKET}/public/*`,
      }],
    }))
    assert.equal(evaluatePolicy(policy, target()), 'Allow')
  })

  it('lets an explicit Deny beat an Allow regardless of order', () => {
    const statements = [
      { Effect: 'Allow', Principal: '*', Action: 's3:*', Resource: '*' },
      { Effect: 'Deny', Principal: '*', Action: 's3:GetObject', Resource: '*' },
    ]
    for (const ordered of [statements, [...statements].reverse()]) {
      const policy = parsePolicy(JSON.stringify({ Statement: ordered }))
      assert.equal(evaluatePolicy(policy, target()), 'Deny')
    }
  })

  it('matches wildcards in actions and resources', () => {
    const policy = parsePolicy(JSON.stringify({
      Statement: [{ Effect: 'Allow', Principal: '*', Action: 's3:Get*', Resource: 'arn:aws:s3:::*' }],
    }))
    assert.equal(evaluatePolicy(policy, target()), 'Allow')
    assert.equal(evaluatePolicy(policy, target({ action: 's3:PutObject' })), 'NoDecision')
  })

  it('treats ? as a single-character wildcard, not a literal dot', () => {
    const policy = parsePolicy(JSON.stringify({
      Statement: [{
        Effect: 'Allow', Principal: '*', Action: 's3:GetObject',
        Resource: `arn:aws:s3:::${BUCKET}/public/fil?.txt`,
      }],
    }))
    assert.equal(evaluatePolicy(policy, target()), 'Allow')
    assert.equal(evaluatePolicy(policy, target({
      resource: `arn:aws:s3:::${BUCKET}/public/filX.txt`,
    })), 'Allow')
    assert.equal(evaluatePolicy(policy, target({
      resource: `arn:aws:s3:::${BUCKET}/public/file2.txt`,
    })), 'NoDecision')
  })

  it('escapes regex metacharacters that are not wildcards', () => {
    const policy = parsePolicy(JSON.stringify({
      Statement: [{
        Effect: 'Allow', Principal: '*', Action: 's3:GetObject',
        Resource: `arn:aws:s3:::${BUCKET}/a+b(c).txt`,
      }],
    }))
    assert.equal(evaluatePolicy(policy, target({
      resource: `arn:aws:s3:::${BUCKET}/a+b(c).txt`,
    })), 'Allow')
    assert.equal(evaluatePolicy(policy, target({
      resource: `arn:aws:s3:::${BUCKET}/aab(c)xtxt`,
    })), 'NoDecision')
  })

  it('does not let a wildcard resource leak across buckets', () => {
    const policy = parsePolicy(JSON.stringify({
      Statement: [{
        Effect: 'Allow', Principal: '*', Action: 's3:GetObject',
        Resource: 'arn:aws:s3:::other-bucket/*',
      }],
    }))
    assert.equal(evaluatePolicy(policy, target()), 'NoDecision')
  })

  it('honours NotAction and NotResource', () => {
    const policy = parsePolicy(JSON.stringify({
      Statement: [{
        Effect: 'Deny', Principal: '*', NotAction: 's3:GetObject', Resource: '*',
      }],
    }))
    assert.equal(evaluatePolicy(policy, target()), 'NoDecision')
    assert.equal(evaluatePolicy(policy, target({ action: 's3:DeleteObject' })), 'Deny')
  })

  it('scopes a principal', () => {
    const policy = parsePolicy(JSON.stringify({
      Statement: [{
        Effect: 'Allow', Principal: { AWS: 'arn:aws:iam::s3node:user/AKIDONE' },
        Action: 's3:*', Resource: '*',
      }],
    }))
    assert.equal(evaluatePolicy(policy, target({
      context: { principal: 'arn:aws:iam::s3node:user/AKIDONE' },
    })), 'Allow')
    assert.equal(evaluatePolicy(policy, target({ context: { principal: '*' } })), 'NoDecision')
  })

  it('evaluates StringEquals and StringLike conditions', () => {
    const policy = parsePolicy(JSON.stringify({
      Statement: [{
        Effect: 'Allow', Principal: '*', Action: 's3:ListBucket', Resource: '*',
        Condition: { StringLike: { 's3:prefix': 'public/*' } },
      }],
    }))
    assert.equal(evaluatePolicy(policy, target({
      action: 's3:ListBucket', context: { principal: '*', 's3:prefix': 'public/photos/' },
    })), 'Allow')
    assert.equal(evaluatePolicy(policy, target({
      action: 's3:ListBucket', context: { principal: '*', 's3:prefix': 'private/' },
    })), 'NoDecision')
  })

  it('treats a missing condition key as unsatisfied unless IfExists is used', () => {
    const strict = parsePolicy(JSON.stringify({
      Statement: [{
        Effect: 'Allow', Principal: '*', Action: 's3:*', Resource: '*',
        Condition: { StringEquals: { 's3:prefix': 'public/' } },
      }],
    }))
    assert.equal(evaluatePolicy(strict, target()), 'NoDecision')

    const lenient = parsePolicy(JSON.stringify({
      Statement: [{
        Effect: 'Allow', Principal: '*', Action: 's3:*', Resource: '*',
        Condition: { StringEqualsIfExists: { 's3:prefix': 'public/' } },
      }],
    }))
    assert.equal(evaluatePolicy(lenient, target()), 'Allow')
  })

  it('evaluates IP conditions', () => {
    const policy = parsePolicy(JSON.stringify({
      Statement: [{
        Effect: 'Allow', Principal: '*', Action: 's3:*', Resource: '*',
        Condition: { IpAddress: { 'aws:SourceIp': '10.0.0.0/8' } },
      }],
    }))
    assert.equal(evaluatePolicy(policy, target({
      context: { principal: '*', 'aws:sourceip': '10.1.2.3' },
    })), 'Allow')
    assert.equal(evaluatePolicy(policy, target({
      context: { principal: '*', 'aws:sourceip': '192.168.1.1' },
    })), 'NoDecision')
  })

  it('matches CIDR ranges', () => {
    assert.equal(ipInCidr('10.1.2.3', '10.0.0.0/8'), true)
    assert.equal(ipInCidr('11.1.2.3', '10.0.0.0/8'), false)
    assert.equal(ipInCidr('127.0.0.1', '127.0.0.1/32'), true)
    assert.equal(ipInCidr('127.0.0.2', '127.0.0.1/32'), false)
    assert.equal(ipInCidr('::ffff:10.1.2.3', '10.0.0.0/8'), true)
    assert.equal(ipInCidr('1.2.3.4', '0.0.0.0/0'), true)
  })

  it('rejects malformed policies', () => {
    assert.throws(() => parsePolicy('not json'), (err) => err.code === 'MalformedPolicy')
    assert.throws(() => parsePolicy('{}'), (err) => err.code === 'MalformedPolicy')
    assert.throws(() => parsePolicy(JSON.stringify({ Statement: [{ Effect: 'Maybe' }] })),
      (err) => err.code === 'MalformedPolicy')
    assert.throws(() => parsePolicy(JSON.stringify({ Statement: [{ Effect: 'Allow' }] })),
      (err) => err.code === 'MalformedPolicy')
  })

  it('rejects an unsupported condition operator at write time', () => {
    assert.throws(() => parsePolicy(JSON.stringify({
      Statement: [{
        Effect: 'Allow', Principal: '*', Action: 's3:*', Resource: '*',
        Condition: { ArnFictional: { 'aws:x': 'y' } },
      }],
    })), (err) => err.code === 'MalformedPolicy')
  })

  // Validation must not short-circuit the way evaluation does: the first
  // operator here fails against an empty context, and the bogus one after it
  // still has to be caught at write time rather than on some later request.
  it('checks every operator, not just up to the first unsatisfied one', () => {
    assert.throws(() => parsePolicy(JSON.stringify({
      Statement: [{
        Effect: 'Allow', Principal: '*', Action: 's3:*', Resource: '*',
        Condition: {
          StringEquals: { 'aws:useragent': 'curl' },
          TotallyBogusOperator: { 'aws:x': 'y' },
        },
      }],
    })), (err) => err.code === 'MalformedPolicy')
  })

  it('accepts an IfExists suffix on a supported operator', () => {
    const policy = parsePolicy(JSON.stringify({
      Statement: [{
        Effect: 'Allow', Principal: '*', Action: 's3:GetObject', Resource: '*',
        Condition: { StringEqualsIfExists: { 'aws:useragent': 'curl' } },
      }],
    }))
    // Absent from the context, so the test is skipped and the statement matches.
    assert.equal(evaluatePolicy(policy, target()), 'Allow')
    assert.equal(evaluatePolicy(policy, target({
      context: { principal: '*', 'aws:useragent': 'wget' },
    })), 'NoDecision')
  })
})

describe('policy enforcement over HTTP', () => {
  let harness
  let client
  let other

  before(async () => {
    harness = await startServer()
    client = harness.client
    other = harness.other
  })

  after(async () => { await harness.cleanup() })

  beforeEach(async () => {
    const listing = await client.request({ method: 'GET' })
    for (const name of allTags(listing.text, 'Name')) {
      const page = await client.request({ method: 'GET', bucket: name, query: { 'list-type': '2' } })
      for (const key of allTags(page.text, 'Key')) {
        await client.request({ method: 'DELETE', bucket: name, key })
      }
      await client.request({ method: 'DELETE', bucket: name })
    }
    await client.request({ method: 'PUT', bucket: BUCKET })
  })

  const setPolicy = (policy) => client.request({
    method: 'PUT', bucket: BUCKET, query: { policy: '' }, body: JSON.stringify(policy),
  })

  it('denies anonymous access by default', async () => {
    await client.request({ method: 'PUT', bucket: BUCKET, key: 'public/a.txt', body: 'hello' })
    const response = await client.send({ method: 'GET', path: `/${BUCKET}/public/a.txt`, headers: {} })
    assert.equal(response.status, 403)
    assert.equal(tag(response.text, 'Code'), 'AccessDenied')
  })

  it('allows anonymous reads once a policy grants them', async () => {
    await client.request({ method: 'PUT', bucket: BUCKET, key: 'public/a.txt', body: 'hello' })
    await client.request({ method: 'PUT', bucket: BUCKET, key: 'private/b.txt', body: 'secret' })

    assert.equal((await setPolicy({
      Version: '2012-10-17',
      Statement: [{
        Effect: 'Allow', Principal: '*', Action: 's3:GetObject',
        Resource: `arn:aws:s3:::${BUCKET}/public/*`,
      }],
    })).status, 204)

    const allowed = await client.send({ method: 'GET', path: `/${BUCKET}/public/a.txt`, headers: {} })
    assert.equal(allowed.status, 200)
    assert.equal(allowed.text, 'hello')

    // The grant is scoped to public/, so private/ stays closed.
    const denied = await client.send({ method: 'GET', path: `/${BUCKET}/private/b.txt`, headers: {} })
    assert.equal(denied.status, 403)
  })

  it('lets an explicit Deny override an authenticated credential', async () => {
    await client.request({ method: 'PUT', bucket: BUCKET, key: 'locked.txt', body: 'x' })
    await setPolicy({
      Statement: [{
        Effect: 'Deny', Principal: '*', Action: 's3:GetObject',
        Resource: `arn:aws:s3:::${BUCKET}/locked.txt`,
      }],
    })

    const response = await client.request({ method: 'GET', bucket: BUCKET, key: 'locked.txt' })
    assert.equal(response.status, 403)
    // Other keys are unaffected.
    await client.request({ method: 'PUT', bucket: BUCKET, key: 'open.txt', body: 'y' })
    assert.equal((await client.request({ method: 'GET', bucket: BUCKET, key: 'open.txt' })).status, 200)
  })

  it('scopes a Deny to one principal', async () => {
    await client.request({ method: 'PUT', bucket: BUCKET, key: 'k.txt', body: 'x' })
    await setPolicy({
      Statement: [{
        Effect: 'Deny',
        Principal: { AWS: `arn:aws:iam::s3node:user/${harness.other.accessKeyId}` },
        Action: 's3:GetObject', Resource: `arn:aws:s3:::${BUCKET}/*`,
      }],
    })
    assert.equal((await client.request({ method: 'GET', bucket: BUCKET, key: 'k.txt' })).status, 200)
    assert.equal((await other.request({ method: 'GET', bucket: BUCKET, key: 'k.txt' })).status, 403)
  })

  it('applies an s3:prefix condition to ListBucket', async () => {
    await client.request({ method: 'PUT', bucket: BUCKET, key: 'public/a.txt', body: 'x' })
    await setPolicy({
      Statement: [{
        Effect: 'Allow', Principal: '*', Action: 's3:ListBucket',
        Resource: `arn:aws:s3:::${BUCKET}`,
        Condition: { StringLike: { 's3:prefix': 'public/*' } },
      }],
    })

    const allowed = await client.send({
      method: 'GET', path: `/${BUCKET}?list-type=2&prefix=public/`, headers: {},
    })
    assert.equal(allowed.status, 200)

    const denied = await client.send({
      method: 'GET', path: `/${BUCKET}?list-type=2&prefix=private/`, headers: {},
    })
    assert.equal(denied.status, 403)
  })

  it('round-trips and deletes the policy document', async () => {
    const policy = {
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Principal: '*', Action: 's3:GetObject', Resource: '*' }],
    }
    await setPolicy(policy)

    const stored = await client.request({ method: 'GET', bucket: BUCKET, query: { policy: '' } })
    assert.equal(stored.status, 200)
    assert.deepEqual(JSON.parse(stored.text), policy)

    assert.equal((await client.request({
      method: 'DELETE', bucket: BUCKET, query: { policy: '' },
    })).status, 204)
    const missing = await client.request({ method: 'GET', bucket: BUCKET, query: { policy: '' } })
    assert.equal(missing.status, 404)
    assert.equal(tag(missing.text, 'Code'), 'NoSuchBucketPolicy')
  })

  it('rejects a malformed policy document', async () => {
    const response = await client.request({
      method: 'PUT', bucket: BUCKET, query: { policy: '' }, body: '{ not json',
    })
    assert.equal(response.status, 400)
    assert.equal(tag(response.text, 'Code'), 'MalformedPolicy')
  })

  it('still refuses anonymous writes when only reads were granted', async () => {
    await setPolicy({
      Statement: [{ Effect: 'Allow', Principal: '*', Action: 's3:GetObject', Resource: '*' }],
    })
    const response = await client.send({
      method: 'PUT', path: `/${BUCKET}/anon.txt`, headers: { 'content-length': '2' }, body: Buffer.from('no'),
    })
    assert.equal(response.status, 403)
  })
})
