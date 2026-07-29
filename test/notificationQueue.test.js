import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { MetadataStore } from '../dist/src/storage/metadata.js'
import { NotificationDispatcher } from '../dist/src/features/notifications.js'

function notificationConfig(endpoint) {
  return { targets: [{ id: 'hook', endpoint, events: ['s3:ObjectCreated:*'], filter: {} }] }
}

function queueRows(metadata) {
  return metadata.db.prepare('SELECT * FROM notification_queue ORDER BY id').all()
}

let metadata

beforeEach(() => {
  metadata = new MetadataStore(':memory:')
  metadata.createBucket('bkt', 'us-east-1')
  metadata.putConfig('bkt', 'notification', notificationConfig('http://example.invalid/hook'))
})

afterEach(() => { metadata.close() })

describe('notification queue', () => {
  it('dispatch() only enqueues — it never touches the network', () => {
    let calls = 0
    const dispatcher = new NotificationDispatcher({ metadata }, {
      fetchImpl: async () => { calls++; throw new Error('should not be called') },
      intervalMs: 0,
    })
    dispatcher.dispatch({ bucket: 'bkt', eventName: 'ObjectCreated:Put', key: 'a', size: 5 })
    assert.equal(calls, 0)
    assert.equal(queueRows(metadata).length, 1)
    assert.equal(queueRows(metadata)[0].status, 'pending')
  })

  it('retries with exponential backoff, then delivers and removes the row', async () => {
    let now = 1_000_000
    let calls = 0
    const dispatcher = new NotificationDispatcher({ metadata }, {
      fetchImpl: async () => {
        calls++
        if (calls < 3) throw new Error('boom')
        return new Response(null, { status: 200 })
      },
      now: () => now,
      intervalMs: 0,
      baseBackoffMs: 1000,
      maxBackoffMs: 60_000,
      maxAttempts: 6,
    })
    dispatcher.dispatch({ bucket: 'bkt', eventName: 'ObjectCreated:Put', key: 'a', size: 5 })

    await dispatcher.processQueue()
    assert.equal(calls, 1)
    let [row] = queueRows(metadata)
    assert.equal(row.status, 'pending')
    assert.equal(row.attempts, 1)
    assert.equal(row.next_attempt_at, now + 1000) // 1000 * 2^0

    // Sweeping again before the backoff elapses must not retry early.
    await dispatcher.processQueue()
    assert.equal(calls, 1)

    now += 1000
    await dispatcher.processQueue()
    assert.equal(calls, 2)
    ;[row] = queueRows(metadata)
    assert.equal(row.attempts, 2)
    assert.equal(row.next_attempt_at, now + 2000) // 1000 * 2^1

    now += 2000
    await dispatcher.processQueue()
    assert.equal(calls, 3)
    assert.equal(queueRows(metadata).length, 0)
  })

  it('moves an event to dead-letter after exceeding maxAttempts, and stops retrying it', async () => {
    let now = 0
    let calls = 0
    const dispatcher = new NotificationDispatcher({ metadata }, {
      fetchImpl: async () => { calls++; throw new Error('always fails') },
      now: () => now,
      intervalMs: 0,
      maxAttempts: 2,
      baseBackoffMs: 10,
      maxBackoffMs: 100,
    })
    dispatcher.dispatch({ bucket: 'bkt', eventName: 'ObjectCreated:Put', key: 'a' })

    await dispatcher.processQueue()
    now += 10
    await dispatcher.processQueue()

    let [row] = queueRows(metadata)
    assert.equal(row.status, 'dead')
    assert.equal(row.attempts, 2)
    assert.equal(calls, 2)

    // A dead row is not 'pending', so it is never claimed by another sweep.
    now += 1000
    await dispatcher.processQueue()
    assert.equal(calls, 2)
    ;[row] = queueRows(metadata)
    assert.equal(row.status, 'dead')
  })

  it("drain() runs one sweep and waits for it, even though there's no background timer", async () => {
    const dispatcher = new NotificationDispatcher({ metadata }, {
      fetchImpl: async () => new Response(null, { status: 200 }),
      intervalMs: 0,
    })
    dispatcher.dispatch({ bucket: 'bkt', eventName: 'ObjectCreated:Put', key: 'a' })
    await dispatcher.drain()
    assert.equal(queueRows(metadata).length, 0)
  })

  it('two concurrent sweeps never both deliver the same row', async () => {
    let inFlight = 0
    let maxConcurrent = 0
    const dispatcher = new NotificationDispatcher({ metadata }, {
      fetchImpl: async () => {
        inFlight++
        maxConcurrent = Math.max(maxConcurrent, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 5))
        inFlight--
        return new Response(null, { status: 200 })
      },
      intervalMs: 0,
    })
    dispatcher.dispatch({ bucket: 'bkt', eventName: 'ObjectCreated:Put', key: 'a' })

    await Promise.all([dispatcher.processQueue(), dispatcher.processQueue()])
    assert.equal(maxConcurrent, 1, 'the same row must not be claimed by both concurrent sweeps')
    assert.equal(queueRows(metadata).length, 0)
  })
})
