import { describe, it, expect, vi, beforeEach } from "vitest"
import { MentionCache, GitAwareCache } from "@/features/mentions/search/cache"

describe("MentionCache", () => {
  let cache: MentionCache
  beforeEach(() => {
    cache = new MentionCache({ maxSize: 3, defaultTtl: 1000 })
  })

  it("get returns null on miss", () => {
    expect(cache.get("k")).toBeNull()
  })

  it("set and get", () => {
    cache.set("k", 42)
    expect(cache.get("k")).toBe(42)
  })

  it("expires by ttl", () => {
    vi.useFakeTimers()
    cache.set("k", 1, 10)
    vi.advanceTimersByTime(20)
    expect(cache.get("k")).toBeNull()
    vi.useRealTimers()
  })

  it("evicts LRU at capacity", () => {
    cache.set("a", 1)
    cache.set("b", 2)
    cache.set("c", 3)
    // touch a so b becomes LRU
    cache.get("a")
    cache.set("d", 4)
    expect(cache.get("b")).toBeNull()
    expect(cache.get("a")).toBe(1)
    expect(cache.get("d")).toBe(4)
  })

  it("invalidate pattern", () => {
    cache.set("files:foo", 1)
    cache.set("files:bar", 2)
    cache.set("agents:x", 3)
    expect(cache.invalidate("files:*")).toBe(2)
    expect(cache.get("files:foo")).toBeNull()
    expect(cache.get("agents:x")).toBe(3)
  })

  it("invalidateProvider", () => {
    cache.set("p:q", 1)
    expect(cache.invalidateProvider("p")).toBe(1)
  })

  it("clear resets", () => {
    cache.set("k", 1)
    cache.clear()
    expect(cache.get("k")).toBeNull()
    expect(cache.getStats().size).toBe(0)
  })

  it("stats hitRate", () => {
    cache.set("k", 1)
    cache.get("k")
    cache.get("missing")
    const s = cache.getStats()
    expect(s.hits).toBe(1)
    expect(s.misses).toBe(1)
    expect(s.hitRate).toBe(0.5)
  })

  it("createKey encodes", () => {
    const key = MentionCache.createKey("p", "q", { projectPath: "a:b" })
    expect(key).toBe("p:q:a%3Ab")
  })
})
describe("GitAwareCache", () => {
  it("invalidates files on head change and notifies", () => {
    const c = new GitAwareCache()
    c.set("files:x", 1)
    let notified = false
    c.onHeadChange(() => { notified = true })
    c.updateHead("head1")
    c.updateHead("head2")
    expect(c.get("files:x")).toBeNull()
    expect(notified).toBe(true)
  })

  it("does not invalidate on first head", () => {
    const c = new GitAwareCache()
    c.set("files:x", 1)
    let notified = false
    c.onHeadChange(() => { notified = true })
    c.updateHead("head1")
    expect(c.get("files:x")).toBe(1)
    expect(notified).toBe(false)
  })
})
