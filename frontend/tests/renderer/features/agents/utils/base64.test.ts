import { describe, it, expect } from "vitest"
import { utf8ToBase64, base64ToUtf8 } from "@/features/agents/utils/base64"

describe("base64 utils", () => {
  it("roundtrips ascii", () => {
    const s = "hello"
    expect(base64ToUtf8(utf8ToBase64(s))).toBe(s)
  })
  it("roundtrips unicode", () => {
    const s = "你好 🚀"
    expect(base64ToUtf8(utf8ToBase64(s))).toBe(s)
  })
  it("encodes empty", () => {
    expect(utf8ToBase64("")).toBe("")
  })
})
