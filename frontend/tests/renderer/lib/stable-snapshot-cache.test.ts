import { describe, expect, it } from "vitest"
import { StableSnapshotCache } from "../../../src/renderer/lib/stable-snapshot-cache"

describe("StableSnapshotCache", () => {
  it("computes once and reuses while clean", () => {
    const cache = new StableSnapshotCache<number>()
    let calls = 0
    const first = cache.get(() => {
      calls += 1
      return 42
    })
    const second = cache.get(() => {
      calls += 1
      return 7
    })

    expect(first).toBe(42)
    expect(second).toBe(42)
    expect(calls).toBe(1)
  })

  it("recomputes after invalidate", () => {
    const cache = new StableSnapshotCache<number>()
    cache.get(() => 1)
    cache.invalidate()
    const next = cache.get(() => 2)

    expect(next).toBe(2)
  })

  it("resets to empty state", () => {
    const cache = new StableSnapshotCache<number>()
    cache.get(() => 1)
    cache.reset()
    let calls = 0
    const value = cache.get(() => {
      calls += 1
      return 9
    })

    expect(value).toBe(9)
    expect(calls).toBe(1)
  })
})