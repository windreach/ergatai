import { describe, it, expect } from "vitest"
import { isSafeHttpUrl } from "@/lib/url-utils"

describe("url-utils", () => {
  describe("isSafeHttpUrl", () => {
    it("should accept valid HTTP URLs", () => {
      expect(isSafeHttpUrl("http://example.com")).toBe(true)
      expect(isSafeHttpUrl("http://localhost:3000")).toBe(true)
      expect(isSafeHttpUrl("http://127.0.0.1")).toBe(true)
      expect(isSafeHttpUrl("http://example.com/path?query=value")).toBe(true)
    })

    it("should accept valid HTTPS URLs", () => {
      expect(isSafeHttpUrl("https://example.com")).toBe(true)
      expect(isSafeHttpUrl("https://api.example.com/v1")).toBe(true)
      expect(isSafeHttpUrl("https://example.com:8080/path")).toBe(true)
    })

    it("should reject non-HTTP protocols", () => {
      expect(isSafeHttpUrl("ftp://example.com")).toBe(false)
      expect(isSafeHttpUrl("file:///etc/passwd")).toBe(false)
      expect(isSafeHttpUrl("javascript:alert(1)")).toBe(false)
      expect(isSafeHttpUrl("data:text/html,<script>alert(1)</script>")).toBe(false)
      expect(isSafeHttpUrl("mailto:user@example.com")).toBe(false)
      expect(isSafeHttpUrl("tel:+1234567890")).toBe(false)
    })

    it("should reject invalid URLs", () => {
      expect(isSafeHttpUrl("")).toBe(false)
      expect(isSafeHttpUrl("not-a-url")).toBe(false)
      expect(isSafeHttpUrl("http://")).toBe(false)
      expect(isSafeHttpUrl("://missing-protocol")).toBe(false)
    })

    it("should reject URLs with dangerous schemes", () => {
      expect(isSafeHttpUrl("vbscript:alert(1)")).toBe(false)
      expect(isSafeHttpUrl("view-source:https://example.com")).toBe(false)
      expect(isSafeHttpUrl("ws://websocket.example.com")).toBe(false)
      expect(isSafeHttpUrl("wss://websocket.example.com")).toBe(false)
    })

    it("should handle URLs with authentication", () => {
      expect(isSafeHttpUrl("http://user:pass@example.com")).toBe(true)
      expect(isSafeHttpUrl("https://user:pass@example.com/path")).toBe(true)
    })

    it("should handle URLs with fragments", () => {
      expect(isSafeHttpUrl("http://example.com#section")).toBe(true)
      expect(isSafeHttpUrl("https://example.com/path#fragment")).toBe(true)
    })

    it("should handle internationalized domain names", () => {
      expect(isSafeHttpUrl("http://例子.com")).toBe(true)
      expect(isSafeHttpUrl("https://тест.com")).toBe(true)
    })

    it("should handle URLs with special characters in path", () => {
      expect(isSafeHttpUrl("http://example.com/path%20with%20spaces")).toBe(true)
      expect(isSafeHttpUrl("https://example.com/path/with/slashes")).toBe(true)
    })

    it("should reject malformed URLs", () => {
      expect(isSafeHttpUrl("http://")).toBe(false)
      expect(isSafeHttpUrl("http://?")).toBe(false)
      expect(isSafeHttpUrl("http://#")).toBe(false)
    })

    it("should handle edge cases with whitespace", () => {
      // JavaScript URL constructor trims whitespace automatically
      expect(isSafeHttpUrl(" http://example.com")).toBe(true)
      expect(isSafeHttpUrl("http://example.com ")).toBe(true)
      expect(isSafeHttpUrl("http://example.com\n")).toBe(true)
    })

    it("should handle very long URLs", () => {
      const longPath = "a".repeat(2000)
      expect(isSafeHttpUrl(`http://example.com/${longPath}`)).toBe(true)
    })

    it("should handle URLs with multiple query parameters", () => {
      expect(isSafeHttpUrl("http://example.com?a=1&b=2&c=3")).toBe(true)
      expect(isSafeHttpUrl("https://example.com?param1=value1&param2=value2")).toBe(true)
    })

    it("should handle URLs with encoded characters", () => {
      expect(isSafeHttpUrl("http://example.com/path%2Fwith%2Fslashes")).toBe(true)
      expect(isSafeHttpUrl("https://example.com?q=hello%20world")).toBe(true)
    })
  })
})
