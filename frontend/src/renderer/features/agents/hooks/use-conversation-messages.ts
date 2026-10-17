import { useState, useRef, useEffect } from "react"
import { trpc } from "../../../lib/trpc"

/**
 * Message type representing a normalized conversation message.
 *
 * This mirrors the shape returned by `trpc.ergatai.listConversationMessages`
 * (see `mapMessage` in the main-process tRPC router).
 */
export type Message = {
  id: string
  conversationId: string
  sequence: number
  role: string
  parts: unknown[]
  metadata: Record<string, unknown> | null
  createdAt: Date
}

/**
 * Hook that loads and manages the messages for a single conversation.
 *
 * Combines historical loading via REST query with real-time updates via SSE subscription.
 * Messages are deduplicated by id and sorted by sequence number.
 */
export function useConversationMessages(conversationId: string): {
  messages: Message[]
  isLoading: boolean
  error: Error | null
} {
  const [messages, setMessages] = useState<Message[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const lastSequenceRef = useRef(0)

  // 1. Historical loading via REST
  const { data: historyData, error: historyError, isLoading: isHistoryLoading } =
    trpc.ergatai.listConversationMessages.useQuery(
      { conversationId },
      {
        enabled: !!conversationId,
      }
    )

  // Update state when history data loads
  useEffect(() => {
    if (historyData) {
      // tRPC 已经返回 Message[] 类型（通过 mapMessage 转换）
      setMessages(historyData)
      lastSequenceRef.current = Math.max(...historyData.map((m) => m.sequence), 0)
      setIsLoading(false)
    }
  }, [historyData, conversationId])

  // Handle loading state
  useEffect(() => {
    if (!isHistoryLoading && !historyData) {
      setIsLoading(false)
    }
  }, [isHistoryLoading, historyData, conversationId])

  // 2. Real-time subscription via SSE (tRPC bridge)
  const { error: subscriptionError } =
    trpc.ergatai.subscribeConversationMessages.useSubscription(
      { conversationId, afterSequence: lastSequenceRef.current },
      {
        enabled: !!conversationId && !isLoading,
        onData: (msg) => {
          // tRPC 已经返回 Message 类型（通过 mapMessage 转换）
          setMessages((prev) => {
            // Dedup by id
            if (prev.some((m) => m.id === msg.id)) return prev
            // Append and sort by sequence
            return [...prev, msg].sort((a, b) => a.sequence - b.sequence)
          })
          lastSequenceRef.current = Math.max(lastSequenceRef.current, msg.sequence)
        },
      }
    )

  return {
    messages,
    isLoading,
    error: historyError || subscriptionError
      ? new Error((historyError || subscriptionError)?.message ?? "Unknown error")
      : null,
  }
}
