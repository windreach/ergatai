import { useLayoutEffect } from "react"
import { useSetAtom } from "jotai"

import { syncMessagesWithStatusAtom } from "../../agents"
export interface RuntimeSessionMessageProjectionInput {
  conversationId: string
  messages: unknown[]
  status: string
  updateGlobal?: boolean
}

/**
 * Single adapter that projects RuntimeSessionStore's merged view into the
 * Jotai message store. Centralizes the previously duplicated layout-effect
 * sync so all migrated chat paths share one projection entry point.
 */
export function useRuntimeSessionMessageProjection({
  conversationId,
  messages,
  status,
  updateGlobal = false,
}: RuntimeSessionMessageProjectionInput): void {
  const syncMessages = useSetAtom(syncMessagesWithStatusAtom)

  useLayoutEffect(() => {
    syncMessages({
      messages: messages as never,
      status,
      conversationId,
      updateGlobal,
    })
  }, [messages, status, conversationId, updateGlobal, syncMessages])
}
