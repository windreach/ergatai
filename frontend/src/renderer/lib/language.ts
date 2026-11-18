export type LanguagePreference = "system" | "en" | "zh-CN"

const STORAGE_KEY = "app-language-preference"

function parseLanguagePreference(raw: string | null): LanguagePreference | null {
  if (!raw) return null

  // jotai's atomWithStorage (which owns this key) stores JSON, so "en" is
  // persisted as '"en"'. Older builds wrote the raw value; accept both.
  let value: unknown = raw
  try {
    value = JSON.parse(raw)
  } catch {
    // legacy plain string value
  }

  if (value === "en" || value === "zh-CN" || value === "system") return value
  return null
}

export function getStoredLanguagePreference(): LanguagePreference {
  try {
    return (
      parseLanguagePreference(localStorage.getItem(STORAGE_KEY)) ?? "system"
    )
  } catch {
    // ignore
  }
  return "system"
}

export function setStoredLanguagePreference(value: LanguagePreference): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
  } catch {
    // ignore
  }
}

export function resolveLanguage(pref: LanguagePreference): "en" | "zh-CN" {
  if (pref === "en") return "en"
  if (pref === "zh-CN") return "zh-CN"
  try {
    const lang = (navigator.language || "").toLowerCase()
    if (lang.startsWith("zh")) return "zh-CN"
  } catch {
    // ignore
  }
  return "en"
}
