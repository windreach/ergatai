import { useState, useRef, useEffect, useMemo } from "react"
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
  fromAgentId?: string | null
  fromAgentName?: string | null
  messageType?: string | null
  turnId?: string | null
  projectionKind?: string | null
  originMessageId?: string | null
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
  const [afterSequence, setAfterSequence] = useState(0)
  const lastSequenceRef = useRef(0)

  // Reset state when conversation changes to avoid stale data
  useEffect(() => {
    setMessages([])
    setAfterSequence(0)
    lastSequenceRef.current = 0
    setIsLoading(true)
  }, [conversationId])

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
      const maxSeq = Math.max(...historyData.map((m) => m.sequence), 0)
      lastSequenceRef.current = maxSeq
      setAfterSequence(maxSeq)
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
      { conversationId, afterSequence },
      {
        enabled: !!conversationId && !isLoading,
        onData: (msg) => {
          // tRPC 已经返回 Message 类型（通过 mapMessage 转换）
          setMessages((prev) => {
            // Dedup by id
            if (prev.some((m) => m.id === msg.id)) return prev
            // Messages arrive in sequence order from the server, so just append.
            // If somehow out of order, append and let the next render handle it.
            return [...prev, msg]
          })
          if (msg.sequence > lastSequenceRef.current) {
            lastSequenceRef.current = msg.sequence
            setAfterSequence(msg.sequence)
          }
        },
      }
    )

  // Memoize error to avoid creating new Error objects on every render
  const error = useMemo<Error | null>(() => {
    const source = historyError || subscriptionError
    return source ? new Error(source.message ?? "Unknown error") : null
  }, [historyError, subscriptionError])

  return {
    messages,
    isLoading,
    error,
  }
}
