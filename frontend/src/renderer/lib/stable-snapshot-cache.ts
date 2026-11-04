/**
 * A tiny, reusable cache for "stable snapshot" values.
 *
 * React's `useSyncExternalStore` requires `getSnapshot()` to return the same
 * reference while the underlying state is unchanged. This helper centralizes
 * that pattern so callers do not have to manage `cachedX = null` flags by hand.
 */
export class StableSnapshotCache<T> {
  private value: T | null = null
  private dirty = true

  /** Returns the cached value, recomputing it when dirty. */
  get(compute: () => T): T {
    if (!this.dirty && this.value !== null) {
      return this.value
    }
    this.value = compute()
    this.dirty = false
    return this.value
  }

  /** Marks the cached value as stale; the next `get()` recomputes. */
  invalidate(): void {
    this.dirty = true
  }

  /** Clears the cached value entirely (e.g. on session release). */
  reset(): void {
    this.value = null
    this.dirty = true
  }
}