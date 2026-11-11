import { describe, it, expect } from "vitest"
import {
  buildGenericMentionToken,
  buildQuoteMentionToken,
  parseMention,
  extractFileMentionIds,
  extractFileMentions,
  hasFileMentions,
  extractTextMentions,
} from "@/features/agents/mentions/mentions-utils"

describe("mentions-utils", () => {
  it("builds generic token with default trigger", () => {
    expect(buildGenericMentionToken("file:foo/bar.ts")).toBe("@[file:foo/bar.ts]")
  })

  it("builds generic token with custom trigger", () => {
    expect(buildGenericMentionToken("x", "/")).toBe("/[x]")
  })

  it("builds quote token", () => {
    const tok = buildQuoteMentionToken("preview", "ZW5jb2RlZA==")
    expect(tok).toBe("@[quote:preview:ZW5jb2RlZA==]")
  })

  it("parses quote mention with base64 full text", () => {
    const full = "hello world"
    const enc = btoa(unescape(encodeURIComponent(full)))
    const r = parseMention(`quote:preview:${enc}`)
    expect(r).not.toBeNull()
    expect(r!.type).toBe("quote")
    expect(r!.fullText).toBe(full)
  })

  it("returns null for unknown prefix", () => {
    expect(parseMention("unknown:something")).toBeNull()
  })

  it("parses pasted mention", () => {
    const r = parseMention("pasted:12:preview text|/tmp/file.txt")
    expect(r).not.toBeNull()
    expect(r!.type).toBe("pasted")
    expect(r!.size).toBe(12)
    expect(r!.path).toBe("/tmp/file.txt")
  })
})

describe("extractFileMentionIds", () => {
  it("extracts ids", () => {
    expect(extractFileMentionIds("hi @[file:a.ts] and @[folder:b]")).toEqual(["file:a.ts", "folder:b"])
  })
  it("empty", () => {
    expect(extractFileMentionIds("no mentions")).toEqual([])
  })
})

describe("extractFileMentions", () => {
  it("parses file mentions", () => {
    const ms = extractFileMentions("x @[file:owner/repo:a.ts] y")
    expect(ms).toHaveLength(1)
    expect(ms[0].type).toBe("file")
    expect(ms[0].path).toBe("a.ts")
  })
  it("ignores unknown", () => {
    expect(extractFileMentions("x @[unknown:x]")).toEqual([])
  })
})

describe("hasFileMentions", () => {
  it("true when present", () => {
    expect(hasFileMentions("hi @[file:a.ts]")).toBe(true)
  })
  it("false when absent", () => {
    expect(hasFileMentions("hi")).toBe(false)
  })
})

describe("extractTextMentions", () => {
  it("removes mention and cleans text", () => {
    const { textMentions, cleanedText } = extractTextMentions("hello @[file:owner/repo:a.ts] world")
    expect(textMentions).toHaveLength(1)
    expect(cleanedText).not.toContain("@[")
    expect(cleanedText).not.toContain("@[")
  })
  it("empty", () => {
    const { textMentions, cleanedText } = extractTextMentions("just text")
    expect(textMentions).toEqual([])
    expect(cleanedText).toBe("just text")
  })
})
