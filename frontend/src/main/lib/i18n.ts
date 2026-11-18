import { app } from "electron"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import en from "../../locales/en.json"
import zhCN from "../../locales/zh-CN.json"

type SupportedLocale = "en" | "zh-CN"
export type LanguagePreference = "system" | SupportedLocale

const locales: Record<SupportedLocale, Record<string, unknown>> = {
  en,
  "zh-CN": zhCN,
}

let resolvedLocale: SupportedLocale | null = null

function languagePreferencePath(): string | null {
  try {
    return join(app.getPath("userData"), "language-preference.json")
  } catch {
    return null
  }
}

function systemLocale(): SupportedLocale {
  try {
    const lang = (
      app && typeof app.getLocale === "function" ? app.getLocale() : "en"
    ).toLowerCase()
    return lang.startsWith("zh") ? "zh-CN" : "en"
  } catch {
    return "en"
  }
}

function readPreference(): LanguagePreference {
  const path = languagePreferencePath()
  if (!path) return "system"
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"))
    if (parsed === "en" || parsed === "zh-CN" || parsed === "system") {
      return parsed
    }
  } catch {
    // Missing or invalid file: fall back to the system locale.
  }
  return "system"
}

/**
 * Keep the main-process locale in sync with the renderer preference. The
 * renderer persists the setting in localStorage, which the main process cannot
 * read, so it forwards the preference over IPC and we mirror it to disk.
 */
export function setLanguagePreference(preference: LanguagePreference): void {
  const normalized: LanguagePreference =
    preference === "en" || preference === "zh-CN" || preference === "system"
      ? preference
      : "system"

  const path = languagePreferencePath()
  if (path) {
    try {
      writeFileSync(path, JSON.stringify(normalized), "utf-8")
    } catch {
      // Non-fatal: the in-memory locale still updates.
    }
  }

  resolvedLocale = normalized === "system" ? systemLocale() : normalized
}

export function getLocale(): SupportedLocale {
  if (!resolvedLocale) {
    const preference = readPreference()
    resolvedLocale =
      preference === "system" ? systemLocale() : preference
  }
  return resolvedLocale
}

function get(obj: unknown, key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>(
      (o, k) =>
        o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined,
      obj,
    )
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

export function t(key: string, vars?: Record<string, unknown>): string {
  const current = locales[getLocale()] ?? locales.en
  let text = asString(get(current, key)) ?? asString(get(locales.en, key)) ?? key
  if (vars) {
    text = text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_: string, k: string) =>
      String(vars[k] ?? `{{${k}}}`),
    )
  }
  return text
}

export default { t }
