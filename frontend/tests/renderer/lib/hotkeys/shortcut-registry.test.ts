import { describe, it, expect } from "vitest"
import {
  keysToHotkeyString,
  hotkeyStringToKeys,
  normalizeHotkey,
  keyToDisplay,
  hotkeyToDisplay,
  getShortcutAction,
  getShortcutsByCategory,
} from "@/lib/hotkeys/shortcut-registry"

describe("keysToHotkeyString / hotkeyStringToKeys", () => {
  it("round-trips", () => {
    const keys = ["cmd", "shift", "N"]
    const s = keysToHotkeyString(keys)
    expect(s).toBe("cmd+shift+n")
    expect(hotkeyStringToKeys(s)).toEqual(["cmd", "shift", "N"])
  })
})

describe("normalizeHotkey", () => {
  it("sorts modifiers and normalizes alt/meta", () => {
    expect(normalizeHotkey("shift+cmd+n")).toBe("cmd+shift+n")
    expect(normalizeHotkey("meta+alt+n")).toBe("cmd+opt+n")
  })
})

describe("keyToDisplay / hotkeyToDisplay", () => {
  it("maps modifiers to symbols", () => {
    expect(keyToDisplay("cmd")).toBe("⌘")
    expect(hotkeyToDisplay("cmd+shift+n")).toBe("⌘⇧N")
  })
})

describe("getShortcutAction", () => {
  it("finds by id", () => {
    expect(getShortcutAction("new-agent")?.label).toBe("Create new agent")
  })
  it("returns undefined for unknown", () => {
    expect(getShortcutAction("nope" as any)).toBeUndefined()
  })
})

describe("getShortcutsByCategory", () => {
  it("groups all actions", () => {
    const g = getShortcutsByCategory()
    const total = g.general.length + g.workspaces.length + g.agents.length
    expect(total).toBeGreaterThan(20)
  })
})
