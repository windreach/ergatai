import { describe, it, expect } from "vitest"
import {
  getMonacoLanguage,
  isDataFile,
  getFileViewerType,
  isImageFile,
} from "@/features/file-viewer/utils/language-map"

describe("getMonacoLanguage", () => {
  it("by extension", () => {
    expect(getMonacoLanguage("foo.ts")).toBe("typescript")
    expect(getMonacoLanguage("foo.py")).toBe("python")
    expect(getMonacoLanguage("foo.rs")).toBe("rust")
  })
  it("by filename", () => {
    expect(getMonacoLanguage("Dockerfile")).toBe("dockerfile")
    expect(getMonacoLanguage("package.json")).toBe("json")
  })
  it("unknown -> plaintext", () => {
    expect(getMonacoLanguage("foo.xyz")).toBe("plaintext")
  })
  it("case insensitive ext", () => {
    expect(getMonacoLanguage("foo.TS")).toBe("typescript")
  })
})

describe("isDataFile", () => {
  it("true for csv/db", () => {
    expect(isDataFile("a.csv")).toBe(true)
    expect(isDataFile("a.db")).toBe(true)
  })
  it("false for ts", () => {
    expect(isDataFile("a.ts")).toBe(false)
  })
})

describe("getFileViewerType", () => {
  it("image", () => {
    expect(getFileViewerType("a.png")).toBe("image")
  })
  it("markdown", () => {
    expect(getFileViewerType("a.md")).toBe("markdown")
  })
  it("unsupported", () => {
    expect(getFileViewerType("a.zip")).toBe("unsupported")
  })
  it("code default", () => {
    expect(getFileViewerType("a.ts")).toBe("code")
  })
})

describe("isImageFile", () => {
  it("true for png", () => {
    expect(isImageFile("a.png")).toBe(true)
  })
  it("false for ts", () => {
    expect(isImageFile("a.ts")).toBe(false)
  })
})
