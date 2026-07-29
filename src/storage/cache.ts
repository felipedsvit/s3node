export class LRUCache<K, V> {
  private capacity: number
  private ttl: number
  private map: Map<K, { value: V; expiresAt: number }>

  constructor(capacity: number, ttlMs = 0) {
    this.capacity = capacity
    this.ttl = ttlMs
    this.map = new Map()
  }

  get(key: K): V | undefined {
    const entry = this.map.get(key)
    if (entry === undefined) return undefined

    if (this.ttl > 0 && Date.now() > entry.expiresAt) {
      this.map.delete(key)
      return undefined
    }

    this.map.delete(key)
    this.map.set(key, {
      value: entry.value,
      expiresAt: this.ttl > 0 ? Date.now() + this.ttl : Infinity,
    })
    return entry.value
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key)
    } else if (this.map.size >= this.capacity) {
      const oldest = this.map.keys().next()
      if (!oldest.done) this.map.delete(oldest.value)
    }

    this.map.set(key, {
      value,
      expiresAt: this.ttl > 0 ? Date.now() + this.ttl : Infinity,
    })
  }

  delete(key: K): void {
    this.map.delete(key)
  }

  clear(): void {
    this.map.clear()
  }

  has(key: K): boolean {
    return this.get(key) !== undefined
  }

  get size(): number {
    return this.map.size
  }
}