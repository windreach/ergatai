import { describe, it, expect, beforeEach } from "vitest"
import { MentionSearchEngine } from "@/features/mentions/search/engine"
import { mentionRegistry } from "@/features/mentions/registry"

describe("MentionSearchEngine", () => {
  beforeEach(() => mentionRegistry.clear())

  it("constructor default cache", () => {
    const e = new MentionSearchEngine()
    expect(e.getCacheStats().size).toBe(0)
  })

  it("clearCache resets", () => {
    const e = new MentionSearchEngine()
    e.clearCache()
    expect(e.getCacheStats().size).toBe(0)
  })

  it("cancelAll does not throw", () => {
    const e = new MentionSearchEngine()
    expect(() => e.cancelAll()).not.toThrow()
  })

  it("search with no providers returns empty", async () => {
    const e = new MentionSearchEngine()
    const res = await e.search("@", "q", { projectPath: "/p" })
    expect(res.items).toEqual([])
    expect(res.hasMore).toBe(false)
    expect(res.warnings).toEqual([])
  })

  it("invalidateProvider delegates", () => {
    const e = new MentionSearchEngine()
    expect(() => e.invalidateProvider("p")).not.toThrow()
  })
})
