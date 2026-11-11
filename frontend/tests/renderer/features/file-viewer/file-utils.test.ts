import { describe, it, expect } from "vitest"
import { getFileName, formatFileSize, getFileExtension } from "@/features/file-viewer/utils/file-utils"

describe("file-utils", () => {
  it("getFileName", () => {
    expect(getFileName("a/b/c.ts")).toBe("c.ts")
    expect(getFileName("no-slash")).toBe("no-slash")
  })

  it("formatFileSize", () => {
    expect(formatFileSize(512)).toBe("512 B")
    expect(formatFileSize(1024)).toBe("1.0 KB")
    expect(formatFileSize(2 * 1024 * 1024)).toBe("2.00 MB")
  })

  it("getFileExtension", () => {
    expect(getFileExtension("foo/bar.TS")).toBe(".ts")
    expect(getFileExtension("README")).toBe("")
  })
})
