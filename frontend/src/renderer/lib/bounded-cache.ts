/**
 * A Map-like cache with a bounded size and LRU eviction.
 *
 * Used to replace unbounded `Map` caches in hot paths (e.g. message part
 * caches) so long-running sessions cannot grow memory without limit.
 *
 * The API intentionally mirrors a subset of `Map` so call sites can migrate
 * with minimal changes.
 */
export class BoundedCache<K, V> {
  private readonly cache = new Map<K, V>()

  constructor(
    private readonly maxSize: number,
    private readonly onEvict?: (key: K, value: V | undefined) => void,
  ) {
    if (maxSize <= 0) {
      throw new Error("BoundedCache maxSize must be > 0")
    }
  }

  get size(): number {
    return this.cache.size
  }

  get(key: K): V | undefined {
    const value = this.cache.get(key)
    if (value === undefined) return undefined
    // LRU touch: move to end.
    this.cache.delete(key)
    this.cache.set(key, value)
    return value
  }

  set(key: K, value: V): this {
    if (this.cache.has(key)) {
      this.cache.delete(key)
    } else if (this.cache.size >= this.maxSize) {
      // Evict the least-recently-used entry (first inserted).
      const oldestKey = this.cache.keys().next().value
      if (oldestKey !== undefined) {
        const evicted = this.cache.get(oldestKey)
        this.cache.delete(oldestKey)
        this.onEvict?.(oldestKey, evicted)
      }
    }
    this.cache.set(key, value)
    return this
  }

  has(key: K): boolean {
    return this.cache.has(key)
  }

  delete(key: K): boolean {
    if (!this.cache.has(key)) return false
    const evicted = this.cache.get(key)
    this.cache.delete(key)
    this.onEvict?.(key, evicted)
    return true
  }

  clear(): void {
    if (this.onEvict) {
      for (const [key, value] of this.cache) {
        this.onEvict(key, value)
      }
    }
    this.cache.clear()
  }

  keys(): IterableIterator<K> {
    return this.cache.keys()
  }

  values(): IterableIterator<V> {
    return this.cache.values()
  }

  entries(): IterableIterator<[K, V]> {
    return this.cache.entries()
  }

  forEach(callback: (value: V, key: K, map: Map<K, V>) => void): void {
    this.cache.forEach(callback)
  }

  [Symbol.iterator](): IterableIterator<[K, V]> {
    return this.cache[Symbol.iterator]()
  }
}