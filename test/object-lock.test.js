import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import {
  applyDefaultRetention, assertRetentionReplaceable, assertVersionDeletable,
} from '../dist/src/features/objectlock.js'
import { startServer, tag } from './helpers/harness.js'

const inDays = (n) => new Date(Date.now() + n * 86400_000).toISOString()

let harness
let client
let BUCKET

before(async () => { harness = await startServer(); client = harness.client })
after(async () => { await harness.cleanup() })

// A COMPLIANCE-locked version cannot be deleted by anyone until it expires, so
// a shared bucket could never be emptied between tests — which is exactly the
// guarantee under test. Each test therefore gets its own bucket, and the temp
// directory is discarded wholesale at the end.
let counter = 0
beforeEach(async () => {
  BUCKET = `locked-bucket-${counter++}`
  await client.request({ method: 'PUT', bucket: BUCKET })
  await client.request({
    method: 'PUT', bucket: BUCKET, query: { versioning: '' },
    body: '<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>',
  })
  await client.request({
    method: 'PUT', bucket: BUCKET, query: { 'object-lock': '' },
    body: '<ObjectLockConfiguration><ObjectLockEnabled>Enabled</ObjectLockEnabled></ObjectLockConfiguration>',
  })
})

const put = (key, body = 'data', headers = {}) =>
  client.request({ method: 'PUT', bucket: BUCKET, key, body, headers })

const setRetention = (key, versionId, mode, until, headers = {}) =>
  client.request({
    method: 'PUT', bucket: BUCKET, key, query: { retention: '', ...(versionId ? { versionId } : {}) },
    headers,
    body: `<Retention><Mode>${mode}</Mode><RetainUntilDate>${until}</RetainUntilDate></Retention>`,
  })

const setLegalHold = (key, status) =>
  client.request({
    method: 'PUT', bucket: BUCKET, key, query: { 'legal-hold': '' },
    body: `<LegalHold><Status>${status}</Status></LegalHold>`,
  })

describe('object lock guards', () => {
  const future = new Date(Date.now() + 86400_000)
  const past = new Date(Date.now() - 86400_000)

  it('blocks a delete under an active legal hold', () => {
    assert.throws(() => assertVersionDeletable(
      { retentionMode: null, retainUntil: null, legalHold: true }))
  })

  it('blocks COMPLIANCE even with the bypass header', () => {
    assert.throws(() => assertVersionDeletable(
      { retentionMode: 'COMPLIANCE', retainUntil: future, legalHold: false },
      { bypassGovernance: true }))
  })

  it('lets the bypass header through GOVERNANCE only', () => {
    const lock = { retentionMode: 'GOVERNANCE', retainUntil: future, legalHold: false }
    assert.throws(() => assertVersionDeletable(lock))
    assert.doesNotThrow(() => assertVersionDeletable(lock, { bypassGovernance: true }))
  })

  it('allows deletion once retention has lapsed', () => {
    assert.doesNotThrow(() => assertVersionDeletable(
      { retentionMode: 'COMPLIANCE', retainUntil: past, legalHold: false }))
  })

  it('permits extending retention but not shortening it', () => {
    const current = { retentionMode: 'COMPLIANCE', retainUntil: future, legalHold: false }
    const later = new Date(future.getTime() + 86400_000)
    assert.doesNotThrow(() => assertRetentionReplaceable(current, { mode: 'COMPLIANCE', retainUntil: later }))
    assert.throws(() => assertRetentionReplaceable(current, { mode: 'COMPLIANCE', retainUntil: past }))
  })

  it('derives a retain-until date from the bucket default', () => {
    const applied = applyDefaultRetention(
      { enabled: true, defaultRetention: { mode: 'GOVERNANCE', days: 2 } }, 0)
    assert.equal(applied.retentionMode, 'GOVERNANCE')
    assert.equal(applied.retainUntil.getTime(), 2 * 86400_000)
  })
})

describe('object lock over HTTP', () => {
  it('round-trips the bucket configuration', async () => {
    const got = await client.request({ method: 'GET', bucket: BUCKET, query: { 'object-lock': '' } })
    assert.equal(got.status, 200)
    assert.equal(tag(got.text, 'ObjectLockEnabled'), 'Enabled')
  })

  it('refuses to enable Object Lock on an unversioned bucket', async () => {
    const plain = `plain-bucket-${counter++}`
    await client.request({ method: 'PUT', bucket: plain })
    const response = await client.request({
      method: 'PUT', bucket: plain, query: { 'object-lock': '' },
      body: '<ObjectLockConfiguration><ObjectLockEnabled>Enabled</ObjectLockEnabled></ObjectLockConfiguration>',
    })
    assert.equal(response.status, 409)
    assert.equal(tag(response.text, 'Code'), 'InvalidBucketState')
  })

  it('round-trips retention and reports it on HEAD', async () => {
    const stored = await put('doc.txt')
    const versionId = stored.headers['x-amz-version-id']
    const until = inDays(1)
    assert.equal((await setRetention('doc.txt', versionId, 'GOVERNANCE', until)).status, 200)

    const got = await client.request({
      method: 'GET', bucket: BUCKET, key: 'doc.txt', query: { retention: '', versionId },
    })
    assert.equal(tag(got.text, 'Mode'), 'GOVERNANCE')

    const head = await client.request({ method: 'HEAD', bucket: BUCKET, key: 'doc.txt' })
    assert.equal(head.headers['x-amz-object-lock-mode'], 'GOVERNANCE')
  })

  it('refuses to delete a version under GOVERNANCE, and allows the bypass', async () => {
    const stored = await put('gov.txt')
    const versionId = stored.headers['x-amz-version-id']
    await setRetention('gov.txt', versionId, 'GOVERNANCE', inDays(1))

    const denied = await client.request({
      method: 'DELETE', bucket: BUCKET, key: 'gov.txt', query: { versionId },
    })
    assert.equal(denied.status, 403)
    assert.equal(tag(denied.text, 'Code'), 'AccessDenied')

    const bypassed = await client.request({
      method: 'DELETE', bucket: BUCKET, key: 'gov.txt', query: { versionId },
      headers: { 'x-amz-bypass-governance-retention': 'true' },
    })
    assert.equal(bypassed.status, 204)
  })

  it('refuses to delete a version under COMPLIANCE even with the bypass', async () => {
    const stored = await put('comp.txt')
    const versionId = stored.headers['x-amz-version-id']
    await setRetention('comp.txt', versionId, 'COMPLIANCE', inDays(1))

    const bypassed = await client.request({
      method: 'DELETE', bucket: BUCKET, key: 'comp.txt', query: { versionId },
      headers: { 'x-amz-bypass-governance-retention': 'true' },
    })
    assert.equal(bypassed.status, 403)
  })

  it('still allows a delete marker over a locked version', async () => {
    const stored = await put('marker.txt')
    await setRetention('marker.txt', stored.headers['x-amz-version-id'], 'COMPLIANCE', inDays(1))
    // Hiding the object is fine; the locked bytes remain reachable by versionId.
    const deleted = await client.request({ method: 'DELETE', bucket: BUCKET, key: 'marker.txt' })
    assert.equal(deleted.status, 204)
    assert.equal(deleted.headers['x-amz-delete-marker'], 'true')
  })

  it('blocks deletion while a legal hold is on, and releases it when off', async () => {
    const stored = await put('hold.txt')
    const versionId = stored.headers['x-amz-version-id']
    assert.equal((await setLegalHold('hold.txt', 'ON')).status, 200)

    const denied = await client.request({
      method: 'DELETE', bucket: BUCKET, key: 'hold.txt', query: { versionId },
    })
    assert.equal(denied.status, 403)

    await setLegalHold('hold.txt', 'OFF')
    const allowed = await client.request({
      method: 'DELETE', bucket: BUCKET, key: 'hold.txt', query: { versionId },
    })
    assert.equal(allowed.status, 204)
  })

  it('accepts lock headers on PutObject', async () => {
    const until = inDays(3)
    await put('hdr.txt', 'data', {
      'x-amz-object-lock-mode': 'GOVERNANCE',
      'x-amz-object-lock-retain-until-date': until,
      'x-amz-object-lock-legal-hold': 'ON',
    })
    const head = await client.request({ method: 'HEAD', bucket: BUCKET, key: 'hdr.txt' })
    assert.equal(head.headers['x-amz-object-lock-mode'], 'GOVERNANCE')
    assert.equal(head.headers['x-amz-object-lock-legal-hold'], 'ON')
  })

  it('rejects a mode without a retain-until date', async () => {
    const response = await put('bad.txt', 'data', { 'x-amz-object-lock-mode': 'GOVERNANCE' })
    assert.equal(response.status, 400)
    assert.equal(tag(response.text, 'Code'), 'InvalidRequest')
  })
})
