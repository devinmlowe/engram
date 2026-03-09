/**
 * Simple LRU cache with TTL expiration.
 *
 * - Entries evicted on access if TTL has elapsed
 * - Least-recently-used entry evicted when maxSize exceeded on set()
 * - O(1) get/set/has/invalidate via Map iteration order
 */
export class LRUCache<K, V> {
  private cache = new Map<K, { value: V; expiresAt: number }>();
  private readonly maxSize: number;
  private readonly ttlMs: number;

  constructor(options: { maxSize: number; ttlMs: number }) {
    this.maxSize = options.maxSize;
    this.ttlMs = options.ttlMs;
  }

  /** Get a value, returning undefined if missing or expired. Refreshes LRU position. */
  get(key: K): V | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    // TTL check
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }

    // Refresh LRU position by re-inserting
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.value;
  }

  /** Set a value, evicting LRU entries if maxSize is exceeded. */
  set(key: K, value: V): void {
    // Remove existing entry to refresh position
    this.cache.delete(key);

    // Evict LRU (first entry in Map) if at capacity
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value!;
      this.cache.delete(firstKey);
    }

    this.cache.set(key, {
      value,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  /** Check if key exists and is not expired. */
  has(key: K): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return false;
    }

    return true;
  }

  /** Remove a specific entry. */
  invalidate(key: K): void {
    this.cache.delete(key);
  }

  /** Remove all entries. */
  clear(): void {
    this.cache.clear();
  }

  /** Number of entries (including potentially expired ones not yet evicted). */
  get size(): number {
    return this.cache.size;
  }
}
