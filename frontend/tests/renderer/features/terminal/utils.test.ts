import { describe, it, expect } from "vitest"
import { getTerminalScopeKey, isSharedTerminalScope, shellEscapePaths } from "@/features/terminal/utils"

describe("terminal utils", () => {
  it("scope key worktree mode", () => {
    expect(getTerminalScopeKey({ branch: "main", worktreePath: "/x", id: "1" })).toBe("ws:1")
  })

  it("scope key local mode with path", () => {
    expect(getTerminalScopeKey({ branch: null, worktreePath: "/proj", id: "1" })).toBe("path:/proj")
  })

  it("scope key default", () => {
    expect(getTerminalScopeKey({ branch: null, worktreePath: null, id: "1" })).toBe("ws:1")
  })

  it("isSharedTerminalScope", () => {
    expect(isSharedTerminalScope("path:/proj")).toBe(true)
    expect(isSharedTerminalScope("ws:1")).toBe(false)
  })

  it("shellEscapePaths", () => {
    expect(shellEscapePaths(["a.txt", "b c.txt"])).toBe('a.txt "b c.txt"')
    expect(shellEscapePaths([])).toBe("")
  })
})
