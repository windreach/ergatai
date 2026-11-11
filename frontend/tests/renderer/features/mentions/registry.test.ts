import { describe, it, expect, beforeEach } from "vitest"
import { mentionRegistry } from "@/features/mentions/registry"
import { createMentionProvider } from "@/features/mentions/types/provider"

function makeProvider(id: string, char = "@", priority = 50) {
  return createMentionProvider({
    id,
    name: id,
    group: { id: "g", label: "g", priority },
    trigger: { char },
    priority,
    search: async () => ({ items: [], hasMore: false }),
    serialize: (i) => i.id,
    deserialize: (t) => ({ id: t, label: t }),
  })
}

describe("mentionRegistry", () => {
  beforeEach(() => mentionRegistry.clear())

  it("registers and gets", () => {
    const p = makeProvider("p1")
    const unreg = mentionRegistry.register(p)
    expect(mentionRegistry.has("p1")).toBe(true)
    expect(mentionRegistry.get("p1")).toBe(p)
    expect(mentionRegistry.getAll()).toContain(p)
    unreg()
    expect(mentionRegistry.has("p1")).toBe(false)
  })

  it("getByTrigger filters", () => {
    const a = makeProvider("a", "@")
    const b = makeProvider("b", "#")
    mentionRegistry.registerAll([a, b])
    expect(mentionRegistry.getByTrigger("@")).toEqual([a])
    expect(mentionRegistry.getByTrigger("#")).toEqual([b])
  })

  it("getAvailable filters by isAvailable", () => {
    const p = makeProvider("p", "@")
    // override isAvailable
    const withAvail = { ...p, isAvailable: () => false }
    mentionRegistry.register(withAvail as any)
    expect(mentionRegistry.getAvailable({})).toEqual([])
  })

  it("getGroups dedups", () => {
    mentionRegistry.register(makeProvider("a", "@"))
    mentionRegistry.register(makeProvider("b", "#"))
    const groups = mentionRegistry.getGroups()
    expect(groups.length).toBe(1)
  })

  it("clear removes all", () => {
    mentionRegistry.register(makeProvider("a"))
    mentionRegistry.clear()
    expect(mentionRegistry.getAll()).toEqual([])
  })

  it("subscribe notifies", () => {
    let n = 0
    const unsub = mentionRegistry.subscribe(() => { n++ })
    mentionRegistry.register(makeProvider("a"))
    expect(n).toBe(1)
    unsub()
  })
})
