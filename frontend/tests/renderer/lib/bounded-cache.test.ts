import { describe, expect, it } from "vitest"
import { BoundedCache } from "../../../src/renderer/lib/bounded-cache"

describe("BoundedCache", () => {
  it("returns undefined for missing keys", () => {
    const cache = new BoundedCache<string, number>(2)
    expect(cache.get("a")).toBeUndefined()
  })

  it("stores and retrieves values", () => {
    const cache = new BoundedCache<string, number>(2)
    cache.set("a", 1)
    expect(cache.get("a")).toBe(1)
  })

  it("evicts the least-recently-used entry when full", () => {
    const cache = new BoundedCache<string, number>(2)
    cache.set("a", 1)
    cache.set("b", 2)
    // touch a so b becomes LRU
    cache.get("a")
    cache.set("c", 3)

    expect(cache.get("a")).toBe(1)
    expect(cache.get("b")).toBeUndefined()
    expect(cache.get("c")).toBe(3)
  })

  it("updates size and supports clear/delete", () => {
    const cache = new BoundedCache<string, number>(2)
    cache.set("a", 1)
    cache.set("b", 2)
    expect(cache.size).toBe(2)
    cache.delete("a")
    expect(cache.size).toBe(1)
    cache.clear()
    expect(cache.size).toBe(0)
  })

  it("invokes onEvict when evicting or deleting", () => {
    const evicted: Array<[string, number | undefined]> = []
    const cache = new BoundedCache<string, number>(1, (key, value) => {
      evicted.push([key, value])
    })

    cache.set("a", 1)
    cache.set("b", 2) // evicts a
    cache.delete("b")

    expect(evicted).toEqual([
      ["a", 1],
      ["b", 2],
    ])
  })
})