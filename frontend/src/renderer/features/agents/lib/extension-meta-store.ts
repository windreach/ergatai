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