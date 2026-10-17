import { useEffect, useRef } from 'react'
import type { UIMessage } from '@ai-sdk/react'

interface UseAutoTriggerOptions {
  conversationId: string
  isStreaming: boolean
  isGroupMode: boolean
  messages: UIMessage[]
  sendMessage: (message: any) => void
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
  const autoTriggerUserMessageRef = useRef<any>(null)
  const autoTriggerReceivedContentRef = useRef(new Set<string>())

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
    const textParts = (userMessage.parts as any[]).filter((p: any) => p.type === "text")
    const promptText = textParts.map((p: any) => p.text).join("\n")
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
  }, [messages, isStreaming, conversationId, isGroupMode, setMessages])

  // Effect 2: After messages are cleared, send the message
  useEffect(() => {
    if (isGroupMode) return
    if (autoTriggerPendingRef.current !== conversationId) return
    if (messages.length > 0) return // Wait for messages to be cleared
    if (!autoTriggerUserMessageRef.current) return

    console.log("[AutoTrigger] Messages cleared, sending message")

    const userMessage = autoTriggerUserMessageRef.current
    autoTriggerPendingRef.current = null
    autoTriggerUserMessageRef.current = null

    // Now send the message - useChat will handle real-time streaming
    sendMessage({ role: "user", parts: userMessage.parts })
  }, [messages, conversationId, isGroupMode, sendMessage])

  return {
    autoTriggeredRef,
    autoTriggerReceivedContentRef,
  }
}
