import { describe, it, expect } from "vitest"
import { getToolErrorText, getToolFilePath } from "@/features/agents/ui/agent-tool-utils"
import { getToolStatus } from "@/features/agents/ui/agent-tool-registry"

describe("getToolFilePath", () => {
  it("prefers _locations", () => {
    expect(
      getToolFilePath({
        input: {
          _locations: [{ path: "/worktree/src/main.ts" }],
          path: "/ignored.ts",
        },
      }),
    ).toBe("/worktree/src/main.ts")
  })

  it("falls back to input.path for persisted parts without _locations", () => {
    expect(
      getToolFilePath({
        input: {
          content: "public class HelloWorld {}",
          path: "/home/yubing/.ergatai/HelloWorld.java",
        },
      }),
    ).toBe("/home/yubing/.ergatai/HelloWorld.java")
  })

  it("falls back to file_path", () => {
    expect(getToolFilePath({ input: { file_path: "/tmp/a.rs" } })).toBe("/tmp/a.rs")
  })

  it("returns empty string when no path is available", () => {
    expect(getToolFilePath({ input: {} })).toBe("")
    expect(getToolFilePath(undefined)).toBe("")
  })
})

describe("getToolErrorText", () => {
  it("reads live tool errors", () => {
    expect(getToolErrorText({ error: "EISDIR: illegal operation on a directory" })).toBe(
      "EISDIR: illegal operation on a directory",
    )
  })

  it("reads persisted/projected errorText", () => {
    expect(getToolErrorText({ errorText: "file not found" })).toBe("file not found")
  })

  it("extracts nested output content blocks", () => {
    expect(
      getToolErrorText({
        output: {
          content: [{ type: "text", text: "permission denied" }],
        },
      }),
    ).toBe("permission denied")
  })

  it("returns empty string when no failure text is present", () => {
    expect(getToolErrorText({ output: undefined })).toBe("")
    expect(getToolErrorText(undefined)).toBe("")
  })
})

describe("getToolStatus", () => {
  it("treats persisted error state as terminal error", () => {
    const status = getToolStatus({
      type: "tool-Read",
      state: "error",
      error: "EISDIR: illegal operation on a directory",
    })
    expect(status.isError).toBe(true)
    expect(status.isPending).toBe(false)
  })

  it("treats live output-error state as terminal error", () => {
    const status = getToolStatus(
      { type: "tool-Read", state: "output-error", error: "permission denied" },
      "streaming",
    )
    expect(status.isError).toBe(true)
    expect(status.isPending).toBe(false)
  })
})
