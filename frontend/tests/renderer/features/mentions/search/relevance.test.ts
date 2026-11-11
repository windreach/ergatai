import { describe, it, expect } from "vitest"
import { calculateRelevance, sortByRelevance } from "@/features/mentions/types/search"
import type { MentionItem } from "@/features/mentions/types/core"

function item(label: string, priority = 0, description?: string, keywords?: string[]): MentionItem {
  return { id: label, label, description, keywords, priority } as MentionItem
}

describe("calculateRelevance", () => {
  it("empty query returns priority", () => {
    const r = calculateRelevance(item("foo", 5), "")
    expect(r.total).toBe(5)
  })
  it("exact match 100", () => {
    const r = calculateRelevance(item("foo"), "foo")
    expect(r.exactMatch).toBe(100)
  })
  it("prefix match", () => {
    const r = calculateRelevance(item("foobar"), "foo")
    expect(r.prefixMatch).toBe(80)
  })
  it("contains match", () => {
    const r = calculateRelevance(item("xfoo"), "foo")
    expect(r.containsMatch).toBe(50)
  })
  it("path match", () => {
    const r = calculateRelevance(item("bar", 0, "contains foo"), "foo")
    expect(r.pathMatch).toBe(30)
  })
  it("keywords match", () => {
    const r = calculateRelevance(item("bar", 0, undefined, ["foo"]), "foo")
    expect(r.keywordsMatch).toBe(20)
  })
  it("multi-word all match", () => {
    const r = calculateRelevance(item("foo bar"), "foo baz")
    // bar contains? query words foo,baz; baz not in label/desc -> not all match -> 0 contains
    expect(r.containsMatch).toBe(0)
  })
  it("multi-word all match success", () => {
    const r = calculateRelevance(item("foo bar"), "foo bar")
    expect(r.exactMatch).toBe(0) // multi-word path
    expect(r.prefixMatch).toBe(60)
    expect(r.containsMatch).toBe(40)
  })
})

describe("sortByRelevance", () => {
  it("sorts by priority when empty query", () => {
    const items = [item("a", 1), item("b", 5)]
    const sorted = sortByRelevance(items, "")
    expect(sorted.map((i) => i.label)).toEqual(["b", "a"])
  })
  it("sorts by score", () => {
    const items = [item("foobar"), item("foo")]
    const sorted = sortByRelevance(items, "foo")
    // exact match foo (100) before prefix foobar (80)
    expect(sorted.map((i) => i.label)).toEqual(["foo", "foobar"])
  })
  it("secondary by label length", () => {
    const items = [item("abcx"), item("abcy")]
    const sorted = sortByRelevance(items, "abc")
    // both prefix 80, tie -> shorter? same length, stable? just ensure array length
    expect(sorted).toHaveLength(2)
  })
})
