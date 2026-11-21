import { describe, expect, it } from "vitest"
import { extractPromptSuggestion } from "../../../../../src/renderer/features/agents/lib/extension-meta-store"

describe("extractPromptSuggestion", () => {
  it("reads the OpenCode object shape", () => {
    expect(
      extractPromptSuggestion({
        suggestions: [{ text: "查一下 opencode 的运行状态" }],
      }),
    ).toBe("查一下 opencode 的运行状态")
  })

  it("reads an array of strings", () => {
    expect(extractPromptSuggestion(["first", "second"])).toBe("first")
  })

  it("reads a plain string", () => {
    expect(extractPromptSuggestion("  keep going  ")).toBe("keep going")
  })

  it("reads nested object text fields", () => {
    expect(extractPromptSuggestion({ suggestions: [{ prompt: "run tests" }] })).toBe("run tests")
  })

  it("returns an empty string for unknown shapes", () => {
    expect(extractPromptSuggestion({ suggestions: [] })).toBe("")
    expect(extractPromptSuggestion(null)).toBe("")
    expect(extractPromptSuggestion(42)).toBe("")
  })
})
