import { useCallback, useSyncExternalStore } from "react"

export type ExtensionMetaSnapshot = Record<string, unknown> | null

type Listener = () => void

const state = new Map<string, ExtensionMetaSnapshot>()
const listeners = new Set<Listener>()

function notify() {
  for (const listener of listeners) listener()
}

export function updateExtensionMeta(agentId: string, kind: string, payload: unknown): void {
  const prev = state.get(agentId) ?? {}
  state.set(agentId, { ...prev, [kind]: payload })
  notify()
}

export function getExtensionMeta(agentId: string): ExtensionMetaSnapshot {
  return state.get(agentId) ?? null
}

export function subscribeExtensionMeta(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * Extract the first prompt suggestion from an adapter-specific payload.
 *
 * Adapters disagree on the shape, e.g.:
 * - `{ suggestions: [{ text: "..." }] }` (OpenCode)
 * - `{ suggestions: ["..."] }`
 * - `["..."]` or `"..."` (JetBrains AIR)
 */
export function extractPromptSuggestion(payload: unknown): string {
  if (!payload) return ""
  if (typeof payload === "string") return payload.trim()

  if (Array.isArray(payload)) return firstSuggestionText(payload)

  if (typeof payload === "object") {
    const obj = payload as Record<string, unknown>
    for (const key of ["suggestions", "prompts", "items", "list"]) {
      const value = obj[key]
      if (Array.isArray(value)) {
        const text = firstSuggestionText(value)
        if (text) return text
      }
    }
    for (const key of ["text", "suggestion", "prompt"]) {
      const value = obj[key]
      if (typeof value === "string" && value.trim()) return value.trim()
    }
  }

  return ""
}

function firstSuggestionText(items: unknown[]): string {
  for (const item of items) {
    if (typeof item === "string" && item.trim()) return item.trim()
    if (!item || typeof item !== "object") continue
    const obj = item as Record<string, unknown>
    for (const key of ["text", "suggestion", "prompt", "value"]) {
      const value = obj[key]
      if (typeof value === "string" && value.trim()) return value.trim()
    }
  }
  return ""
}

export function useExtensionMeta(agentId: string | null): ExtensionMetaSnapshot {
  const subscribe = useCallback(
    (listener: Listener) => (agentId ? subscribeExtensionMeta(listener) : () => {}),
    [agentId],
  )
  const getSnapshot = useCallback(
    () => (agentId ? getExtensionMeta(agentId) : null),
    [agentId],
  )
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}