import { describe, it, expect } from "vitest"
import {
  getToolFilePath,
  resolveWorkspaceRelativePath,
} from "@/features/agents/ui/agent-tool-utils"

describe("getToolFilePath", () => {
  it("prefers nested _locations provided by the live runtime", () => {
    expect(
      getToolFilePath({
        input: {
          path: "plan-test.md",
          _locations: [{ path: "/workspace/plan-test.md" }],
        },
      }),
    ).toBe("/workspace/plan-test.md")
  })

  it("falls back to top-level locations on persisted ACP parts", () => {
    expect(
      getToolFilePath({
        input: { path: "plan-test.md" },
        locations: [{ path: "/workspace/plan-test.md" }],
      }),
    ).toBe("/workspace/plan-test.md")
  })

  it("falls back to raw input path when no locations exist", () => {
    expect(getToolFilePath({ input: { path: "plan-test.md" } })).toBe("plan-test.md")
    expect(getToolFilePath({ input: { file_path: "/tmp/plan.md" } })).toBe("/tmp/plan.md")
    expect(getToolFilePath(null)).toBe("")
  })
})

describe("resolveWorkspaceRelativePath", () => {
  it("joins agent-relative paths with the chat workspace", () => {
    expect(
      resolveWorkspaceRelativePath("plan-test.md", "/home/user/project"),
    ).toBe("/home/user/project/plan-test.md")
    expect(
      resolveWorkspaceRelativePath("./plan-test.md", "/home/user/project/"),
    ).toBe("/home/user/project/plan-test.md")
  })

  it("keeps absolute paths untouched", () => {
    expect(
      resolveWorkspaceRelativePath("/home/user/project/plan-test.md", "/other"),
    ).toBe("/home/user/project/plan-test.md")
    expect(resolveWorkspaceRelativePath("C:\\repo\\plan.md", "/home/user/project")).toBe(
      "C:\\repo\\plan.md",
    )
  })

  it("returns the original path when no workspace is known", () => {
    expect(resolveWorkspaceRelativePath("plan-test.md", null)).toBe("plan-test.md")
  })
})
