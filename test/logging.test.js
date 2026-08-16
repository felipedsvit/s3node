import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { startServer } from './helpers/harness.js'

let harness
const entries = []

before(async () => {
  harness = await startServer({ logger: { error: (entry) => entries.push(entry) } })
})
after(async () => { await harness.cleanup() })

describe('safe request logging', () => {
  it('redacts presigned credentials and signatures without logging signing material', async () => {
    const response = await harness.client.send({
      method: 'GET',
      path: '/?X-Amz-Credential=AKID%2Fscope&X-Amz-Signature=top-secret-signature&X-Amz-Security-Token=session-secret',
      headers: {},
    })
    assert.equal(response.status, 400)
    const entry = entries.at(-1)
    assert.doesNotMatch(JSON.stringify(entry), /top-secret-signature|session-secret|AKID%2Fscope/)
    assert.match(entry.url, /X-Amz-Signature=%5BREDACTED%5D/)
    assert.equal('canonicalRequest' in entry, false)
    assert.equal('stringToSign' in entry, false)
  })
})
