import { describe, it, expect } from "vitest"
import { getThemesByType, getThemeById, isBuiltinTheme } from "@/lib/vscode-themes"

describe("vscode-themes", () => {
  it("getThemesByType dark", () => {
    const dark = getThemesByType("dark")
    expect(dark.length).toBeGreaterThan(0)
    expect(dark.every((t) => t.type === "dark")).toBe(true)
  })

  it("getThemeById", () => {
    expect(getThemeById("dark-plus")?.name).toBe("Dark+ (default dark)")
    expect(getThemeById("nope")).toBeUndefined()
  })

  it("isBuiltinTheme", () => {
    expect(isBuiltinTheme("poimandres")).toBe(true)
    expect(isBuiltinTheme("nope")).toBe(false)
  })
})
