import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { startServer } from './helpers/harness.js'

describe('server-level rate limiting', () => {
  let harness

  after(async () => { await harness?.cleanup() })

  it('throttles a caller that bursts past the configured limit', async () => {
    harness = await startServer({ rateLimitPerSecond: 2, rateLimitBurst: 2 })
    const results = []
    for (let i = 0; i < 4; i++) {
      results.push((await harness.client.request({ method: 'GET' })).status)
    }
    assert.ok(results.includes(503), `expected at least one SlowDown response, got ${JSON.stringify(results)}`)
  })

  it('does not throttle when rate limiting is left disabled', async () => {
    const disabled = await startServer()
    try {
      const results = []
      for (let i = 0; i < 10; i++) {
        results.push((await disabled.client.request({ method: 'GET' })).status)
      }
      assert.ok(results.every((status) => status === 200))
    } finally {
      await disabled.cleanup()
    }
  })
})
