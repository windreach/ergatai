import { describe, it, expect, beforeEach } from "vitest"
import {
  migrateStorageKey,
  migrateWindowScopedStorageKey,
} from "@/lib/window-storage"

describe("migrateStorageKey", () => {
  beforeEach(() => localStorage.clear())

  it("migrates when target missing and legacy present", () => {
    localStorage.setItem("legacy", "v")
    migrateStorageKey("current", "legacy")
    expect(localStorage.getItem("current")).toBe("v")
  })

  it("does nothing when target exists", () => {
    localStorage.setItem("current", "c")
    localStorage.setItem("legacy", "v")
    migrateStorageKey("current", "legacy")
    expect(localStorage.getItem("current")).toBe("c")
  })

  it("does nothing when legacy missing", () => {
    migrateStorageKey("current", "legacy")
    expect(localStorage.getItem("current")).toBeNull()
  })
})

describe("migrateWindowScopedStorageKey", () => {
  beforeEach(() => localStorage.clear())

  it("migrates scoped key", () => {
    // default window id is "main"
    localStorage.setItem("main:legacy", "v")
    migrateWindowScopedStorageKey("current", "legacy")
    expect(localStorage.getItem("main:current")).toBe("v")
  })

  it("does nothing when target exists", () => {
    localStorage.setItem("main:current", "c")
    localStorage.setItem("main:legacy", "v")
    migrateWindowScopedStorageKey("current", "legacy")
    expect(localStorage.getItem("main:current")).toBe("c")
  })
})
