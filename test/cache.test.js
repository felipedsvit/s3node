import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { LRUCache } from '../dist/src/storage/cache.js'

describe('LRUCache', () => {
  it('returns undefined for a missing key', () => {
    const cache = new LRUCache(3)
    assert.equal(cache.get('missing'), undefined)
  })

  it('returns a stored value', () => {
    const cache = new LRUCache(3)
    cache.set('a', 1)
    assert.equal(cache.get('a'), 1)
  })

  it('evicts the least recently used entry when at capacity', () => {
    const cache = new LRUCache(3)
    cache.set('a', 1)
    cache.set('b', 2)
    cache.set('c', 3)
    cache.set('d', 4)
    assert.equal(cache.get('a'), undefined, 'a should be evicted')
    assert.equal(cache.get('b'), 2)
    assert.equal(cache.get('c'), 3)
    assert.equal(cache.get('d'), 4)
  })

  it('promotes a recently accessed entry to the most recent position', () => {
    const cache = new LRUCache(3)
    cache.set('a', 1)
    cache.set('b', 2)
    cache.set('c', 3)
    cache.get('a')
    cache.set('d', 4)

    assert.equal(cache.get('a'), 1, 'a should survive after being promoted')
    assert.equal(cache.get('b'), undefined, 'b should be evicted')
  })

  it('updates the value of an existing key and promotes it', () => {
    const cache = new LRUCache(3)
    cache.set('a', 1)
    cache.set('b', 2)
    cache.set('c', 3)
    cache.set('a', 99)

    assert.equal(cache.get('a'), 99)
    cache.set('d', 4)
    assert.equal(cache.get('b'), undefined, 'b should be evicted, not a')
  })

  it('deletes a specific key', () => {
    const cache = new LRUCache(3)
    cache.set('a', 1)
    cache.set('b', 2)
    cache.delete('a')
    assert.equal(cache.get('a'), undefined)
    assert.equal(cache.get('b'), 2)
  })

  it('clears all entries', () => {
    const cache = new LRUCache(3)
    cache.set('a', 1)
    cache.set('b', 2)
    cache.clear()
    assert.equal(cache.get('a'), undefined)
    assert.equal(cache.get('b'), undefined)
    assert.equal(cache.size, 0)
  })

  it('has() returns true for a present key', () => {
    const cache = new LRUCache(3)
    cache.set('a', 1)
    assert.equal(cache.has('a'), true)
    assert.equal(cache.has('b'), false)
  })

  it('eviction order matches access order, not insertion order', () => {
    const cache = new LRUCache(2)
    cache.set('a', 1)
    cache.set('b', 2)
    cache.get('a')
    cache.set('c', 3)

    assert.equal(cache.get('a'), 1, 'a should survive after being read')
    assert.equal(cache.get('b'), undefined, 'b should be evicted')
    assert.equal(cache.get('c'), 3)
  })

  it('handles null and undefined values correctly', () => {
    const cache = new LRUCache(3)
    cache.set('null', null)
    cache.set('undefined', undefined)
    assert.equal(cache.get('null'), null)
    assert.equal(cache.get('undefined'), undefined)
  })

  it('expires entries after TTL', { timeout: 5000 }, async () => {
    const cache = new LRUCache(10, 50)
    cache.set('a', 1)
    assert.equal(cache.get('a'), 1)
    await new Promise((r) => setTimeout(r, 60))
    assert.equal(cache.get('a'), undefined, 'entry should expire after TTL')
  })

  it('renews TTL on access', { timeout: 5000 }, async () => {
    const cache = new LRUCache(10, 80)
    cache.set('a', 1)
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(cache.get('a'), 1, 'still fresh after 50ms')
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(cache.get('a'), 1, 'access extended TTL')
    await new Promise((r) => setTimeout(r, 150))
    assert.equal(cache.get('a'), undefined, 'should finally expire')
  })

  it('reports the correct size', () => {
    const cache = new LRUCache(5)
    assert.equal(cache.size, 0)
    cache.set('a', 1)
    cache.set('b', 2)
    assert.equal(cache.size, 2)
    cache.set('c', 3)
    assert.equal(cache.size, 3)
    cache.delete('a')
    assert.equal(cache.size, 2)
    cache.clear()
    assert.equal(cache.size, 0)
  })
})