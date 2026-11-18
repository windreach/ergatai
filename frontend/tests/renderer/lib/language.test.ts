import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  getStoredLanguagePreference,
  resolveLanguage,
  setStoredLanguagePreference,
} from "@/lib/language"

const STORAGE_KEY = "app-language-preference"

describe("getStoredLanguagePreference", () => {
  beforeEach(() => localStorage.clear())

  it("reads the JSON value written by atomWithStorage", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify("en"))
    expect(getStoredLanguagePreference()).toBe("en")
  })

  it("reads a legacy plain string", () => {
    localStorage.setItem(STORAGE_KEY, "zh-CN")
    expect(getStoredLanguagePreference()).toBe("zh-CN")
  })

  it("falls back to system for missing or invalid values", () => {
    expect(getStoredLanguagePreference()).toBe("system")
    localStorage.setItem(STORAGE_KEY, "fr")
    expect(getStoredLanguagePreference()).toBe("system")
    localStorage.setItem(STORAGE_KEY, "not-json{")
    expect(getStoredLanguagePreference()).toBe("system")
  })
})

describe("setStoredLanguagePreference", () => {
  beforeEach(() => localStorage.clear())

  it("round-trips through getStoredLanguagePreference", () => {
    setStoredLanguagePreference("en")
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toBe("en")
    expect(getStoredLanguagePreference()).toBe("en")
  })
})

describe("resolveLanguage", () => {
  it("maps explicit preferences directly", () => {
    expect(resolveLanguage("en")).toBe("en")
    expect(resolveLanguage("zh-CN")).toBe("zh-CN")
  })

  it("uses the system locale for system", () => {
    vi.stubGlobal("navigator", { language: "zh-CN" })
    expect(resolveLanguage("system")).toBe("zh-CN")
    vi.stubGlobal("navigator", { language: "en-US" })
    expect(resolveLanguage("system")).toBe("en")
    vi.unstubAllGlobals()
  })
})
