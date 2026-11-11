import { describe, it, expect } from "vitest"
import { getDefaultRatios, addPaneRatio, removePaneRatio } from "@/features/agents/atoms"

describe("getDefaultRatios", () => {
  it("n<=0 returns []", () => {
    expect(getDefaultRatios(0)).toEqual([])
    expect(getDefaultRatios(-1)).toEqual([])
  })
  it("equal split", () => {
    expect(getDefaultRatios(3)).toEqual([1 / 3, 1 / 3, 1 / 3])
  })
})

describe("addPaneRatio", () => {
  it("adds a pane", () => {
    const out = addPaneRatio([0.5, 0.5])
    expect(out).toHaveLength(3)
    const sum = out.reduce((a, b) => a + b, 0)
    expect(sum).toBeCloseTo(1, 10)
    expect(out[2]).toBeCloseTo(1 / 3, 10)
  })
  it("from empty", () => {
    const out = addPaneRatio([])
    expect(out).toHaveLength(1)
    expect(out[0]).toBeCloseTo(1, 10)
  })
})

describe("removePaneRatio", () => {
  it("removes by index", () => {
    const out = removePaneRatio([1 / 3, 1 / 3, 1 / 3], 1)
    expect(out).toHaveLength(2)
    const sum = out.reduce((a, b) => a + b, 0)
    expect(sum).toBeCloseTo(1, 10)
  })
  it("invalid index returns defaults", () => {
    const out = removePaneRatio([0.5, 0.5], 5)
    expect(out).toEqual([0.5, 0.5])
  })
  it("all removed? single element -> []", () => {
    const out = removePaneRatio([1], 0)
    expect(out).toEqual([])
  })
  it("zero sum fallback", () => {
    const out = removePaneRatio([0, 0], 0)
    expect(out.length).toBe(1)
  })
})
