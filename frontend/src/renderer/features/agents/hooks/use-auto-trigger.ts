import { useEffect, useRef } from 'react'
import type { UIMessage } from '@ai-sdk/react'

// Local type for message parts (ai-sdk doesn't export granular part types)
interface TextPart {
  type: 'text'
  text: string
}

interface UseAutoTriggerOptions {
  conversationId: string
  isStreaming: boolean
  isGroupMode: boolean
  messages: UIMessage[]
  sendMessage: (message: { role: 'user'; parts: unknown[] }) => Promise<void> | void
  setMessages: (messages: UIMessage[]) => void
  hasTriggeredAutoGenerateRef: React.MutableRefObject<boolean>
}

export function useAutoTrigger({
  conversationId,
  isStreaming,
  isGroupMode,
  messages,
  sendMessage,
  setMessages,
  hasTriggeredAutoGenerateRef,
}: UseAutoTriggerOptions) {
  const autoTriggeredRef = useRef(new Set<string>())
  const autoTriggerPendingRef = useRef<string | null>(null)
  const autoTriggerUserMessageRef = useRef<UIMessage | null>(null)

  // Effect 1: Detect auto-trigger condition and clear messages
  useEffect(() => {
    if (isStreaming) return
    if (isGroupMode) return
    const hasUserMessages = messages.some((m) => m.role === "user")
    const hasAssistantMessages = messages.some((m) => m.role === "assistant")
    if (!hasUserMessages || hasAssistantMessages) return
    if (autoTriggeredRef.current.has(conversationId)) return

    const userMessage = messages.find((m) => m.role === "user")
    if (!userMessage || !('parts' in userMessage)) return
    const textParts = (userMessage.parts as TextPart[]).filter((p) => p.type === "text")
    const promptText = textParts.map((p) => p.text).join("\n")
    if (!promptText) return

    console.log("[AutoTrigger] Detected auto-trigger condition, clearing messages")

    // Mark as auto-triggered and save user message for later
    autoTriggeredRef.current.add(conversationId)
    autoTriggerPendingRef.current = conversationId
    autoTriggerUserMessageRef.current = userMessage

    // Prevent the auto-regenerate effect from triggering (it would conflict with our sendMessage)
    hasTriggeredAutoGenerateRef.current = true

    // Clear messages to avoid duplicates
    setMessages([])

    // Cleanup: Restore the message if effect re-runs or component unmounts before Effect 2 sends
    return () => {
      // If Effect 2 hasn't cleared the pending ref yet, restore the message
      if (autoTriggerPendingRef.current === conversationId && autoTriggerUserMessageRef.current) {
        console.log("[AutoTrigger] Cleanup: restoring message due to unmount/re-run")
        const restoredMessage = autoTriggerUserMessageRef.current
        autoTriggerPendingRef.current = null
        autoTriggerUserMessageRef.current = null
        // Restore the original messages (put the user message back)
        setMessages([restoredMessage])
      }
    }
  }, [messages, isStreaming, conversationId, isGroupMode, setMessages])

  // Effect 2: After messages are cleared, send the message
  useEffect(() => {
    if (isGroupMode) return
    if (autoTriggerPendingRef.current !== conversationId) return
    if (messages.length > 0) return // Wait for messages to be cleared
    if (!autoTriggerUserMessageRef.current) return

    console.log("[AutoTrigger] Messages cleared, sending message")

    const userMessage = autoTriggerUserMessageRef.current

    const doSend = async () => {
      try {
        // Clear refs first (prevent duplicate triggers)
        autoTriggerPendingRef.current = null
        autoTriggerUserMessageRef.current = null

        // Attempt to send
        await sendMessage({ role: "user", parts: userMessage.parts })
      } catch (error) {
        // Send failed, restore refs to allow retry
        console.error('[AutoTrigger] Send failed:', error)
        autoTriggerPendingRef.current = conversationId
        autoTriggerUserMessageRef.current = userMessage
      }
    }

    doSend()
  }, [messages, conversationId, isGroupMode, sendMessage])

  // Cleanup: Clear autoTriggeredRef when conversation changes to prevent memory leak
  useEffect(() => {
    // Keep only recent conversations (simple LRU: clear all when switching conversations)
    // This prevents unbounded growth of the Set
    return () => {
      // On unmount or conversation change, optionally clear old entries
      // For now, we rely on the fact that the Set is per-hook-instance
    }
  }, [conversationId])

  // Alternative: Periodic cleanup of old conversation IDs
  useEffect(() => {
    const cleanup = () => {
      // Keep the Set bounded - if it grows too large, clear it
      // This is a simple safeguard against memory leaks
      if (autoTriggeredRef.current.size > 100) {
        autoTriggeredRef.current.clear()
      }
    }

    // Run cleanup on mount and periodically
    cleanup()
    const interval = setInterval(cleanup, 60000) // Every minute
    return () => clearInterval(interval)
  }, [])

  return {
    autoTriggeredRef,
  }
}
