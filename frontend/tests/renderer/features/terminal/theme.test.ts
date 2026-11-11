import { describe, it, expect } from "vitest"
import { getTerminalTheme } from "@/features/terminal/config"

describe("getTerminalTheme", () => {
  it("returns dark theme for true", () => {
    const t = getTerminalTheme(true)
    expect(t.background).toBe("#121212")
  })
  it("returns light theme for false", () => {
    const t = getTerminalTheme(false)
    expect(t.background).toBe("#fafafa")
  })
})
