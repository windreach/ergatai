import { useEffect, useLayoutEffect } from "react"
import { useSetAtom } from "jotai"
import { syncMessagesWithStatusAtom, type Message } from "../stores/message-store"
import { useStreamingStatusStore } from "../stores/streaming-status-store"

interface UseMessageSyncProps {
  conversationId: string
  messages: Message[]
  status: "ready" | "streaming" | "submitted" | "error"
  isActive: boolean
  isSplitPane: boolean
}

/**
 * Hook to sync messages to Jotai store for isolated rendering
 * and sync status to global streaming status store for queue processing
 */
export function useMessageSync({
  conversationId,
  messages,
  status,
  isActive,
  isSplitPane,
}: UseMessageSyncProps) {
  // Sync messages to Jotai store for isolated rendering.
  // Each ChatViewInner writes to its own per-chat bucket.
  // Only active pane updates legacy global atoms to avoid cross-pane races/churn.
  const syncMessages = useSetAtom(syncMessagesWithStatusAtom)

  useLayoutEffect(() => {
    syncMessages({ messages, status, conversationId, updateGlobal: isActive })
  }, [messages, status, conversationId, isActive, syncMessages])

  // Sync status to global streaming status store for queue processing
  const setStreamingStatus = useStreamingStatusStore((s) => s.setStatus)
  useEffect(() => {
    setStreamingStatus(conversationId, status)
    return () => {
      // Reset status when conversation changes or component unmounts
      setStreamingStatus(conversationId, "ready")
    }
  }, [conversationId, status, setStreamingStatus])
}
