import { describe, it, expect } from "vitest"
import { isSafeHttpUrl, validateHttpUrl } from "../../../src/main/lib/url-utils"

describe("isSafeHttpUrl", () => {
  it("accepts http/https", () => {
    expect(isSafeHttpUrl("https://example.com")).toBe(true)
    expect(isSafeHttpUrl("http://example.com/path")).toBe(true)
  })
  it("rejects other schemes", () => {
    expect(isSafeHttpUrl("file:///etc/passwd")).toBe(false)
    expect(isSafeHttpUrl("javascript:alert(1)")).toBe(false)
  })
  it("rejects invalid", () => {
    expect(isSafeHttpUrl("not a url")).toBe(false)
  })
})

describe("validateHttpUrl", () => {
  it("throws on unsafe scheme", () => {
    expect(() => validateHttpUrl("ftp://x")).toThrow()
  })
})
