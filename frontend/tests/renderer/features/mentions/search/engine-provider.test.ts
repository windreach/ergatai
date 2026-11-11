import { describe, it, expect, vi } from "vitest"
import { MentionSearchEngine } from "@/features/mentions/search/engine"
import type { MentionProvider, MentionSearchContext, MentionSearchResult } from "@/features/mentions/types"

function makeProvider(id: string, searchFn: (ctx: MentionSearchContext) => Promise<MentionSearchResult>): MentionProvider {
  return {
    id: id as any,
    name: id,
    group: { id: "g", label: "g", priority: 0 },
    trigger: { char: "@", position: "standalone", allowSpaces: true },
    priority: 0,
    search: searchFn,
    serialize: (i: any) => i.id,
    deserialize: (t: string) => ({ id: t, label: t }) as any,
  }
}

describe("MentionSearchEngine.searchProvider", () => {
  it("caches result when useCache", async () => {
    const engine = new MentionSearchEngine()
    let calls = 0
    const provider = makeProvider("p", async (ctx) => {
      calls++
      return { items: [{ id: "x", label: "x" } as any], hasMore: false }
    })
    const ctx: MentionSearchContext = { query: "q", signal: new AbortController().signal, limit: 10 }
    const r1 = await engine.searchProvider(provider, ctx, { useCache: true })
    const r2 = await engine.searchProvider(provider, ctx, { useCache: true })
    expect(r1.items).toHaveLength(1)
    expect(r2.items).toHaveLength(1)
    expect(calls).toBe(1)
  })

  it("does not cache when useCache false", async () => {
    const engine = new MentionSearchEngine()
    let calls = 0
    const provider = makeProvider("p", async () => {
      calls++
      return { items: [], hasMore: false }
    })
    const ctx: MentionSearchContext = { query: "q", signal: new AbortController().signal, limit: 10 }
    await engine.searchProvider(provider, ctx, { useCache: false })
    await engine.searchProvider(provider, ctx, { useCache: false })
    expect(calls).toBe(2)
  })

  it("returns empty on abort", async () => {
    const engine = new MentionSearchEngine()
    const controller = new AbortController()
    controller.abort()
    const provider = makeProvider("p", async (ctx) => {
      if (ctx.signal.aborted) throw new DOMException("aborted", "AbortError")
      return { items: [], hasMore: false }
    })
    const ctx: MentionSearchContext = { query: "q", signal: controller.signal, limit: 10 }
    const r = await engine.searchProvider(provider, ctx)
    expect(r.items).toEqual([])
  })

  it("returns warning on error", async () => {
    const engine = new MentionSearchEngine()
    const provider = makeProvider("p", async () => {
      throw new Error("boom")
    })
    const ctx: MentionSearchContext = { query: "q", signal: new AbortController().signal, limit: 10 }
    const r = await engine.searchProvider(provider, ctx, { useCache: false })
    expect(r.items).toEqual([])
    expect(r.warning).toContain("search failed")
  })

  it("timeout returns warning", async () => {
    vi.useFakeTimers()
    const engine = new MentionSearchEngine()
    const provider = makeProvider("p", async () => {
      await new Promise((resolve) => setTimeout(resolve, 1000))
      return { items: [{ id: "x", label: "x" } as any], hasMore: false }
    })
    const ctx: MentionSearchContext = { query: "q", signal: new AbortController().signal, limit: 10 }
    const promise = engine.searchProvider(provider, ctx, { useCache: false, timeoutMs: 10 })
    vi.advanceTimersByTime(20)
    const r = await promise
    expect(r.items).toEqual([])
    vi.useRealTimers()
  })
})
