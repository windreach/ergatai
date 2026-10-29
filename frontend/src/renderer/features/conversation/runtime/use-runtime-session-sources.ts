import { useEffect } from "react"

import { getRuntimeSessionStore } from "./runtime-session-store"
import type { Message } from "../../agents/stores/message-store"

export type RuntimeSessionSources = {
  conversationId?: string | null
  persistedMessages?: Message[]
  localMessages?: Message[]
  backendRuntimeMessages?: Message[]
}

/**
 * Bridge independent message sources into RuntimeSessionStore.
 *
 * This hook intentionally ingests raw sources only. It must never write a
 * merged/projection array back into the store; merging is owned by the store.
 */
export function useRuntimeSessionSources({
  conversationId,
  persistedMessages = [],
  localMessages = [],
  backendRuntimeMessages = [],
}: RuntimeSessionSources): void {
  const sessionStore = getRuntimeSessionStore()

  // Single effect handles all source updates to minimize re-renders.
  // Each source is only updated when its reference changes.
  useEffect(() => {
    if (!conversationId) return

    sessionStore.ensureSession(conversationId)
    sessionStore.setPersistedMessages(conversationId, persistedMessages)
    sessionStore.setLocalMessages(conversationId, localMessages)
    sessionStore.setRuntimeMessages(conversationId, backendRuntimeMessages)
  }, [
    conversationId,
    persistedMessages,
    localMessages,
    backendRuntimeMessages,
    sessionStore,
  ])
}
