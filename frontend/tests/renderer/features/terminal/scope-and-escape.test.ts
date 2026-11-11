import { describe, it, expect } from "vitest"
import {
  getTerminalScopeKey,
  isSharedTerminalScope,
  shellEscapePaths,
} from "@/features/terminal/utils"

describe("getTerminalScopeKey", () => {
  it("worktree (branch) -> ws:id", () => {
    expect(getTerminalScopeKey({ branch: "main", worktreePath: "/p", id: "1" })).toBe("ws:1")
  })
  it("local with worktreePath -> path:path", () => {
    expect(getTerminalScopeKey({ branch: null, worktreePath: "/p", id: "1" })).toBe("path:/p")
  })
  it("local without worktreePath -> ws:id", () => {
    expect(getTerminalScopeKey({ branch: null, worktreePath: null, id: "1" })).toBe("ws:1")
  })
})

describe("isSharedTerminalScope", () => {
  it("true for path:", () => expect(isSharedTerminalScope("path:/p")).toBe(true))
  it("false for ws:", () => expect(isSharedTerminalScope("ws:1")).toBe(false))
})

describe("shellEscapePaths", () => {
  it("joins simple paths", () => expect(shellEscapePaths(["a", "b"])).toBe("a b"))
  it("quotes paths with spaces", () => expect(shellEscapePaths(["a b"])).toBe('"a b"'))
  it("quotes empty", () => expect(shellEscapePaths([""])).toBe('""'))
  it("escapes quotes", () => expect(shellEscapePaths(['a"b'])).toBe('"a\\"b"'))
  it("empty array", () => expect(shellEscapePaths([])).toBe(""))
})
