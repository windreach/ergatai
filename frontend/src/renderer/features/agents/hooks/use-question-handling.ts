import { useEffect, useMemo, useRef, useState } from "react"
import { useAtom } from "jotai"
import type { UIMessage } from "@ai-sdk/react"
import {
  pendingUserQuestionsAtom,
  expiredUserQuestionsAtom,
} from "../atoms"

interface UseQuestionHandlingOptions {
  conversationId: string
  isStreaming: boolean
  messages: UIMessage[]
  provider?: string
}

export function useQuestionHandling({
  conversationId,
  isStreaming,
  messages,
  provider,
}: UseQuestionHandlingOptions) {
  const [pendingQuestionsMap, setPendingQuestionsMap] = useAtom(
    pendingUserQuestionsAtom,
  )
  // Get pending questions for this specific conversation
  const pendingQuestions = pendingQuestionsMap.get(conversationId) ?? null

  // Expired user questions (timed out but still answerable as normal messages)
  const [expiredQuestionsMap, setExpiredQuestionsMap] = useAtom(
    expiredUserQuestionsAtom,
  )
  const expiredQuestions = expiredQuestionsMap.get(conversationId) ?? null

  // Unified display questions: prefer pending (live), fall back to expired
  const displayQuestions = pendingQuestions ?? expiredQuestions
  const isQuestionExpired = !pendingQuestions && !!expiredQuestions

  // Track whether chat input has content (for custom text with questions)
  const [inputHasContent, setInputHasContent] = useState(false)

  // Memoize the last assistant message to avoid unnecessary recalculations
  const lastAssistantMessage = useMemo(
    () => messages.findLast((m) => m.role === "assistant"),
    [messages],
  )

  // Pre-compute token data for ChatInputArea to avoid passing unstable messages array.
  // Prefer the latest assistant metadata that actually includes token/context fields.
  // This keeps the indicator stable while a new assistant message is streaming.
  const messageTokenData = useMemo(() => {
    const lastAssistantWithTokenData = [...messages].reverse().find((msg) => {
      if (msg.role !== "assistant" || !msg.metadata) return false
      const metadata = msg.metadata as {
        inputTokens?: number
        outputTokens?: number
        totalTokens?: number
        cacheReadInputTokens?: number
        cacheCreationInputTokens?: number
        modelContextWindow?: number
      }

      return (
        metadata.inputTokens !== undefined ||
        metadata.outputTokens !== undefined ||
        metadata.totalTokens !== undefined ||
        metadata.cacheReadInputTokens !== undefined ||
        metadata.cacheCreationInputTokens !== undefined ||
        metadata.modelContextWindow !== undefined
      )
    })

    const metadata = lastAssistantWithTokenData?.metadata as
      | {
          inputTokens?: number
          outputTokens?: number
          totalTokens?: number
          totalCostUsd?: number
          cacheReadInputTokens?: number
          cacheCreationInputTokens?: number
          modelContextWindow?: number
        }
      | undefined

    const cacheReadInputTokens = metadata?.cacheReadInputTokens || 0
    const cacheCreationInputTokens = metadata?.cacheCreationInputTokens || 0
    const codexInputTokensFromTotal =
      metadata?.totalTokens !== undefined
        ? Math.max(0, metadata.totalTokens - (metadata?.outputTokens ?? 0))
        : undefined

    const totalInputTokens =
      provider === "codex"
        ? (codexInputTokensFromTotal ?? metadata?.inputTokens ?? 0)
        : (metadata?.inputTokens || 0) +
          cacheReadInputTokens +
          cacheCreationInputTokens
    const totalOutputTokens = metadata?.outputTokens || 0
    const totalCostUsd = metadata?.totalCostUsd || 0
    const contextWindow = metadata?.modelContextWindow

    // Keep this tied to rendered messages for memo comparator stability.
    const messageCount = messages.length

    return {
      totalInputTokens,
      totalOutputTokens,
      totalCostUsd,
      messageCount,
      contextWindow,
    }
  }, [messages, provider])

  // Track previous streaming state to detect stream stop
  const prevIsStreamingRef = useRef(isStreaming)
  // Track if we recently stopped streaming (to prevent sync effect from restoring)
  const recentlyStoppedStreamRef = useRef(false)

  // Clear pending questions when streaming is aborted
  // This effect runs when isStreaming transitions from true to false
  useEffect(() => {
    const wasStreaming = prevIsStreamingRef.current
    prevIsStreamingRef.current = isStreaming

    // Detect streaming stop transition
    if (wasStreaming && !isStreaming) {
      // Mark that we recently stopped streaming
      recentlyStoppedStreamRef.current = true
      // Clear the flag after a delay
      const flagTimeout = setTimeout(() => {
        recentlyStoppedStreamRef.current = false
      }, 500)

      // Streaming just stopped - if there's a pending question for this chat,
      // clear it after a brief delay (backend already handled the abort)
      if (pendingQuestions) {
        const timeout = setTimeout(() => {
          // Re-check if still showing the same question (might have been cleared by other means)
          setPendingQuestionsMap((current) => {
            if (current.has(conversationId)) {
              const newMap = new Map(current)
              newMap.delete(conversationId)
              return newMap
            }
            return current
          })
        }, 150) // Small delay to allow for race conditions with transport chunks
        return () => {
          clearTimeout(timeout)
          clearTimeout(flagTimeout)
        }
      }
      return () => clearTimeout(flagTimeout)
    }
  }, [isStreaming, conversationId, pendingQuestions, setPendingQuestionsMap])

  // Sync pending questions with messages state
  // This handles: 1) restoring on chat switch, 2) clearing when question is answered/timed out
  useEffect(() => {
    // Check if there's a pending AskUserQuestion in the last assistant message
    const pendingQuestionPart = lastAssistantMessage?.parts?.find(
      (part: any) =>
        part.type === "tool-AskUserQuestion" &&
        part.state !== "output-available" &&
        part.state !== "output-error" &&
        part.state !== "result" &&
        part.input?.questions,
    ) as any | undefined


    // Helper to clear pending question for this conversation
    const clearPendingQuestion = () => {
      setPendingQuestionsMap((current) => {
        if (current.has(conversationId)) {
          const newMap = new Map(current)
          newMap.delete(conversationId)
          return newMap
        }
        return current
      })
    }

    // If streaming and we already have a pending question for this chat, keep it
    // (transport will manage it via chunks)
    if (isStreaming && pendingQuestions) {
      // But if the question in messages is already answered, clear the atom
      if (!pendingQuestionPart) {
        // Check if the specific toolUseId is now answered
        const answeredPart = lastAssistantMessage?.parts?.find(
          (part: any) =>
            part.type === "tool-AskUserQuestion" &&
            part.toolCallId === pendingQuestions.toolUseId &&
            (part.state === "output-available" ||
              part.state === "output-error" ||
              part.state === "result"),
        )
        if (answeredPart) {
          clearPendingQuestion()
        }
      }
      return
    }

    // Not streaming - DON'T restore pending questions from messages
    // If stream is not active, the question is either:
    // 1. Already answered (state would be "output-available")
    // 2. Interrupted/aborted (should not show dialog)
    // 3. Timed out (should not show dialog)
    // We only show the question dialog during active streaming when
    // the backend is waiting for user response.
    if (pendingQuestionPart) {
      // Don't restore - if there's an existing pending question for this chat, clear it
      if (pendingQuestions) {
        clearPendingQuestion()
      }
    } else {
      // No pending question - clear if belongs to this conversation
      if (pendingQuestions) {
        clearPendingQuestion()
      }
    }
  }, [conversationId, lastAssistantMessage, isStreaming, pendingQuestions, setPendingQuestionsMap])

  return {
    pendingQuestions,
    expiredQuestions,
    displayQuestions,
    isQuestionExpired,
    inputHasContent,
    setInputHasContent,
    lastAssistantMessage,
    messageTokenData,
    setPendingQuestionsMap,
    setExpiredQuestionsMap,
    recentlyStoppedStreamRef,
  }
}
