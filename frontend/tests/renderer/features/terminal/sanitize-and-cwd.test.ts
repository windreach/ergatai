import { describe, it, expect } from "vitest"
import { sanitizeForTitle } from "@/features/terminal/commandBuffer"
import { parseCwd } from "@/features/terminal/parseCwd"

describe("sanitizeForTitle", () => {
  it("empty for empty", () => expect(sanitizeForTitle("")).toBe(""))
  it("trims", () => expect(sanitizeForTitle("  ls  ")).toBe("ls"))
  it("strips control chars", () => expect(sanitizeForTitle("a\x00b")).toBe("ab"))
  it("strips ANSI", () => expect(sanitizeForTitle("\x1b[31mred\x1b[0m")).toBe("red"))
  it("truncates long", () => {
    const long = "a".repeat(60)
    const out = sanitizeForTitle(long)
    expect(out.length).toBe(50)
    expect(out.endsWith("...")).toBe(true)
  })
})

describe("parseCwd", () => {
  it("null when no osc7", () => expect(parseCwd("hello")).toBeNull())
  it("parses BEL terminator", () => {
    expect(parseCwd("\x1b]7;file://host/tmp/foo\x07")).toBe("/tmp/foo")
  })
  it("parses ST terminator", () => {
    expect(parseCwd("\x1b]7;file://host/tmp/bar\x1b\\")).toBe("/tmp/bar")
  })
  it("decodes percent-encoded", () => {
    expect(parseCwd("\x1b]7;file://host/tmp/a%20b\x07")).toBe("/tmp/a b")
  })
  it("returns last match", () => {
    const data = "\x1b]7;file://host/first\x07 then \x1b]7;file://host/second\x07"
    expect(parseCwd(data)).toBe("/second")
  })
})
