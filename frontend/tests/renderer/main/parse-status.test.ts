import { describe, it, expect } from "vitest"
import { parseGitLog, parseDiffNumstat, parseNameStatus } from "../../../src/main/lib/git/utils/parse-status"

describe("parseGitLog", () => {
  it("returns empty for blank", () => {
    expect(parseGitLog("")).toEqual([])
    expect(parseGitLog("   ")).toEqual([])
  })
  it("parses a commit line", () => {
    const out = "abc123|abc|feat: x|desc|Alice|2024-01-01"
    const res = parseGitLog(out)
    expect(res.length).toBe(1)
    expect(res[0].hash).toBe("abc123")
    expect(res[0].message).toBe("feat: x")
    expect(res[0].author).toBe("Alice")
  })
  it("skips malformed lines", () => {
    const out = "badline\nabc|abc|m||a|2024-01-01"
    const res = parseGitLog(out)
    expect(res.length).toBe(1)
  })
})

describe("parseDiffNumstat", () => {
  it("parses additions/deletions", () => {
    const out = "10\t2\tsrc/a.ts\n-\t-\tbinary.bin"
    const m = parseDiffNumstat(out)
    expect(m.get("src/a.ts")).toEqual({ additions: 10, deletions: 2 })
    expect(m.get("binary.bin")).toEqual({ additions: 0, deletions: 0 })
  })
  it("handles renames", () => {
    const out = "5\t1\told.ts => new.ts"
    const m = parseDiffNumstat(out)
    expect(m.get("new.ts")).toEqual({ additions: 5, deletions: 1 })
    expect(m.get("old.ts")).toEqual({ additions: 5, deletions: 1 })
  })
})

describe("parseNameStatus", () => {
  it("parses added/deleted/modified", () => {
    const out = "A\tnew.ts\nD\told.ts\nM\tmod.ts"
    const files = parseNameStatus(out)
    expect(files.map(f => f.status)).toEqual(["added", "deleted", "modified"])
  })
  it("parses rename", () => {
    const out = "R100\told.ts\tnew.ts"
    const files = parseNameStatus(out)
    expect(files[0].status).toBe("renamed")
    expect(files[0].path).toBe("new.ts")
    expect(files[0].oldPath).toBe("old.ts")
  })
})
