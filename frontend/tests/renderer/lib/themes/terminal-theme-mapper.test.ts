import { describe, it, expect } from "vitest"
import { extractTerminalTheme, hasTerminalColors } from "@/lib/themes/terminal-theme-mapper"

describe("hasTerminalColors", () => {
  it("true when terminal.background present", () => {
    expect(hasTerminalColors({ "terminal.background": "#000" })).toBe(true)
  })
  it("false when none", () => {
    expect(hasTerminalColors({ "editor.background": "#000" })).toBe(false)
  })
})

describe("extractTerminalTheme", () => {
  it("uses provided colors", () => {
    const t = extractTerminalTheme({ "terminal.background": "#123456", "terminal.foreground": "#ffffff" })
    expect(t.background).toBe("#123456")
    expect(t.foreground).toBe("#ffffff")
  })
  it("falls back when empty", () => {
    const t = extractTerminalTheme({})
    expect(t.background).toBeTruthy()
    expect(t.foreground).toBeTruthy()
  })
  it("uses editor.background when provided", () => {
    const t = extractTerminalTheme({ "editor.background": "#ffffff" })
    expect(t.background).toBe("#ffffff")
  })
})
