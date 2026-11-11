import { describe, it, expect, vi } from "vitest"
import { containsClearScrollbackSequence, extractContentAfterClear } from "../../../src/main/lib/terminal/terminal-escape-filter"
import { DataBatcher } from "../../../src/main/lib/terminal/data-batcher"
import { sanitizeProjectName } from "../../../src/main/lib/git/worktree-naming"

describe("terminal-escape-filter", () => {
  it("detects clear scrollback", () => {
    expect(containsClearScrollbackSequence("\x1b[3J")).toBe(true)
    expect(containsClearScrollbackSequence("hello")).toBe(false)
  })
  it("extracts content after clear", () => {
    const data = "before\x1b[3Jafter"
    expect(extractContentAfterClear(data)).toBe("after")
  })
  it("returns original when no clear", () => {
    expect(extractContentAfterClear("hello")).toBe("hello")
  })
})

describe("DataBatcher", () => {
  it("flushes on size threshold", () => {
    const flushed: string[] = []
    const b = new DataBatcher((d) => flushed.push(d))
    const big = "a".repeat(200 * 1024)
    b.write(big)
    expect(flushed).toEqual([big])
  })
  it("flushes remaining on dispose", () => {
    const flushed: string[] = []
    const b = new DataBatcher((d) => flushed.push(d))
    b.write("hi")
    b.dispose()
    expect(flushed).toContain("hi")
  })
})

describe("sanitizeProjectName", () => {
  it("lowercases and replaces spaces", () => {
    expect(sanitizeProjectName("My Project")).toBe("my-project")
  })
  it("strips special chars", () => {
    expect(sanitizeProjectName("a@b#c")).toBe("abc")
  })
  it("falls back to project", () => {
    expect(sanitizeProjectName("!!!")).toBe("project")
  })
  it("truncates to 50", () => {
    const long = "a".repeat(100)
    expect(sanitizeProjectName(long).length).toBeLessThanOrEqual(50)
  })
})
