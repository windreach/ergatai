import { describe, it, expect } from "vitest"
import { extractGitActivity, extractChangedFiles } from "@/features/agents/utils/git-activity"

describe("extractGitActivity", () => {
  it("null when no parts", () => {
    expect(extractGitActivity([])).toBeNull()
  })
  it("extracts commit", () => {
    const parts = [
      {
        type: "tool-Bash",
        input: { command: 'git commit -m "msg"' },
        output: { stdout: "[main abc123] msg" },
      },
    ]
    const res = extractGitActivity(parts)
    expect(res).toMatchObject({ type: "commit", message: "msg", hash: "abc123" })
  })
  it("PR takes precedence", () => {
    const parts = [
      {
        type: "tool-Bash",
        input: { command: 'git commit -m "msg"' },
        output: { stdout: "[main abc123] msg" },
      },
      {
        type: "tool-Bash",
        input: { command: 'gh pr create --title "My PR"' },
        output: { stdout: "https://github.com/o/r/pull/42" },
      },
    ]
    const res = extractGitActivity(parts)
    expect(res).toMatchObject({ type: "pr", number: 42 })
  })
})

describe("extractChangedFiles", () => {
  it("empty when no parts", () => {
    expect(extractChangedFiles([])).toEqual([])
  })
  it("tracks edit additions/deletions", () => {
    const parts = [
      {
        type: "tool-Edit",
        input: { _locations: [{ path: "/p/a.ts" }], old_string: "a\nb", new_string: "x\ny\nz" },
      },
    ]
    const res = extractChangedFiles(parts, "/p")
    expect(res).toHaveLength(1)
    expect(res[0].displayPath).toBe("a.ts")
    expect(res[0].additions).toBe(3)
    expect(res[0].deletions).toBe(2)
  })
  it("write counts additions", () => {
    const parts = [
      {
        type: "tool-Write",
        input: { _locations: [{ path: "/p/b.ts" }], content: "l1\nl2" },
      },
    ]
    const res = extractChangedFiles(parts)
    expect(res[0].additions).toBe(2)
    expect(res[0].deletions).toBe(0)
  })
  it("skips session files", () => {
    const parts = [
      {
        type: "tool-Write",
        input: { _locations: [{ path: "/x/claude-sessions/foo" }], content: "x" },
      },
    ]
    expect(extractChangedFiles(parts)).toEqual([])
  })
})
