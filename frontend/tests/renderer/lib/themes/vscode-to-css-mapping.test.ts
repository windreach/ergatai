import { describe, it, expect } from "vitest"
import { isLightColor, hexToHSL, getThemeTypeFromColors } from "@/lib/themes/vscode-to-css-mapping"

describe("isLightColor", () => {
  it("white is light", () => expect(isLightColor("#ffffff")).toBe(true))
  it("black is dark", () => expect(isLightColor("#000000")).toBe(false))
  it("shorthand", () => expect(isLightColor("#fff")).toBe(true))
  it("alpha stripped", () => expect(isLightColor("#ffffff80")).toBe(true))
})

describe("hexToHSL", () => {
  it("black", () => expect(hexToHSL("#000000")).toBe("0 0% 0%"))
  it("white", () => expect(hexToHSL("#ffffff")).toBe("0 0% 100%"))
  it("shorthand expands", () => expect(hexToHSL("#000")).toBe("0 0% 0%"))
  it("preserve alpha", () => {
    const out = hexToHSL("#ff000080", undefined, true)
    expect(out).toContain("/")
  })
})

describe("getThemeTypeFromColors", () => {
  it("light for white bg", () => {
    expect(getThemeTypeFromColors({ "editor.background": "#ffffff" })).toBe("light")
  })
  it("dark for black bg", () => {
    expect(getThemeTypeFromColors({ "editor.background": "#000000" })).toBe("dark")
  })
  it("default dark when missing", () => {
    expect(getThemeTypeFromColors({})).toBe("dark")
  })
})
