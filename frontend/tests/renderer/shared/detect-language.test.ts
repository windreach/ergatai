import { describe, it, expect } from "vitest"
import { detectLanguage } from "../../../src/shared/detect-language"

describe("detectLanguage", () => {
  it("detects common extensions", () => {
    expect(detectLanguage("foo.ts")).toBe("typescript")
    expect(detectLanguage("foo.TSX")).toBe("typescript")
    expect(detectLanguage("bar.py")).toBe("python")
    expect(detectLanguage("main.rs")).toBe("rust")
  })
  it("returns plaintext for unknown", () => {
    expect(detectLanguage("foo.unknownext")).toBe("plaintext")
    expect(detectLanguage("noext")).toBe("plaintext")
  })
  it("detects json/yaml", () => {
    expect(detectLanguage("a.json")).toBe("json")
    expect(detectLanguage("a.yml")).toBe("yaml")
  })
})
