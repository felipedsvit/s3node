import { LRUCache } from '../storage/cache.js'

interface Bucket {
  tokens: number
  last: number
}

/**
 * Token-bucket rate limiter, keyed per caller (IP or access key). Bursts up
 * to `capacity` are allowed; sustained traffic is capped at `refillPerSecond`.
 * Backed by an `LRUCache` so tracking many distinct keys (e.g. IPs) can't
 * grow the process memory unbounded.
 */
export class RateLimiter {
  private readonly buckets: LRUCache<string, Bucket>

  constructor(private readonly capacity: number, private readonly refillPerSecond: number, maxTrackedKeys = 10_000) {
    if (capacity <= 0) throw new RangeError('capacity must be positive')
    if (refillPerSecond <= 0) throw new RangeError('refillPerSecond must be positive')
    this.buckets = new LRUCache(maxTrackedKeys)
  }

  /** Returns true if `key` may proceed, consuming `cost` tokens; false if it should be throttled. */
  allow(key: string, cost = 1): boolean {
    const now = Date.now()
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, last: now }
    const elapsedSeconds = (now - bucket.last) / 1000
    const tokens = Math.min(this.capacity, bucket.tokens + elapsedSeconds * this.refillPerSecond)

    if (tokens < cost) {
      this.buckets.set(key, { tokens, last: now })
      return false
    }
    this.buckets.set(key, { tokens: tokens - cost, last: now })
    return true
  }
}
