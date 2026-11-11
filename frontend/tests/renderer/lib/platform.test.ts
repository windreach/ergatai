import { describe, it, expect } from "vitest"
import { isDesktopApp, getPlatform, isMacOS, isWindows, isLinux, getShortcutDisplay, getHotkey } from "@/lib/utils/platform"

describe("platform", () => {
  it("isDesktopApp false in test env", () => expect(isDesktopApp()).toBe(false))
  it("getPlatform unknown in test env", () => expect(getPlatform()).toBe("unknown"))
  it("isMacOS/Windows/Linux false", () => {
    expect(isMacOS()).toBe(false)
    expect(isWindows()).toBe(false)
    expect(isLinux()).toBe(false)
  })
  it("getShortcutDisplay uses web variant", () => expect(getShortcutDisplay("web", "desk")).toBe("web"))
  it("getHotkey uses web variant", () => expect(getHotkey("web", "desk")).toBe("web"))
})
