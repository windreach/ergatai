import { describe, expect, it } from "vitest"
import { buildPermissionPreview } from "@/components/dialogs/permission-tool-preview"

describe("buildPermissionPreview", () => {
  it("builds a diff preview for OpenCode camelCase edit input", () => {
    const preview = buildPermissionPreview({
      path: "test-pty.sh",
      oldString: "a\nb\nc\n",
      newString: "a\nB\nc\n",
    })

    expect(preview).not.toBeNull()
    expect(preview?.filePath).toBe("test-pty.sh")
    expect(preview?.addedLines).toBe(1)
    expect(preview?.removedLines).toBe(1)
    expect(preview?.lines).toEqual([
      { type: "context", content: "a", oldLine: 1, newLine: 1 },
      { type: "removed", content: "b", oldLine: 2 },
      { type: "added", content: "B", newLine: 2 },
      { type: "context", content: "c", oldLine: 3, newLine: 3 },
    ])
  })

  it("supports Claude Code snake_case edit input", () => {
    const preview = buildPermissionPreview({
      file_path: "src/app.ts",
      old_string: "const a = 1\n",
      new_string: "const a = 2\nconst b = 3\n",
    })

    expect(preview?.filePath).toBe("src/app.ts")
    expect(preview?.addedLines).toBe(2)
    expect(preview?.removedLines).toBe(1)
    expect(
      preview?.lines.filter((line) => line.type === "added").map((line) => line.content),
    ).toEqual(["const a = 2", "const b = 3"])
  })

  it("renders write content as added lines", () => {
    const preview = buildPermissionPreview(
      {
        path: "scripts/new.sh",
        content: "#!/usr/bin/env bash\necho hi\n",
      },
      "write",
    )

    expect(preview?.addedLines).toBe(2)
    expect(preview?.removedLines).toBe(0)
    expect(preview?.lines.every((line) => line.type === "added")).toBe(true)
  })

  it("falls back to the raw view for non-file tool inputs", () => {
    expect(buildPermissionPreview({ query: "hello" }, "search")).toBeNull()
  })

  it("truncates long previews and reports hidden lines", () => {
    const content = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n")

    const preview = buildPermissionPreview(
      { path: "big.txt", content },
      "write",
    )

    expect(preview?.lines).toHaveLength(80)
    expect(preview?.hiddenLines).toBe(20)
  })
})
