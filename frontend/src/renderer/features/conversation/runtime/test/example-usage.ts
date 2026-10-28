/**
 * Example usage of the Conversation Runtime abstraction
 *
 * This file demonstrates how to use the new conversation invocation API.
 * It's not meant to be executed, just to show the usage patterns.
 */

import {
  useConversationInvocation,
  useSessionState,
  getConversationInvocationService,
} from "../index"

// ============================================================================
// Example functions for documentation purposes only
// ============================================================================

// These functions demonstrate usage patterns but are not meant to be imported.
// They serve as inline documentation for the conversation runtime API.

/**
 * Example 1: Basic usage in React component
 *
 * Demonstrates how to use useConversationInvocation and useSessionState hooks
 * to send messages and track streaming status in a React component.
 */
function ExampleChatInput({ conversationId, chatId }: { conversationId: string; chatId: string }) {
  const invocation = useConversationInvocation()
  const sessionState = useSessionState(conversationId)

  const handleSend = async (message: string) => {
    const ticket = await invocation.send({
      conversation: {
        chatId,
        conversationId,
        source: "main",
      },
      role: "user",
      parts: [{ type: "text", text: message }],
    })

    console.log("Send ticket:", ticket)
  }

  const handleStop = async () => {
    await invocation.stop({ conversationId, chatId })
  }

  return {
    isStreaming: sessionState?.isStreaming ?? false,
    queueLength: sessionState?.queue.length ?? 0,
    send: handleSend,
    stop: handleStop,
  }
}

/**
 * Example 2: Using service directly (non-React context)
 *
 * Demonstrates how to use getConversationInvocationService() to send messages
 * and manage sessions without React hooks.
 */
async function exampleServiceUsage() {
  const service = getConversationInvocationService()

  // Send a message
  const ticket = await service.send({
    conversation: {
      chatId: "main",
      conversationId: "conv-123",
      source: "main",
    },
    role: "user",
    parts: [{ type: "text", text: "Hello, world!" }],
  })

  console.log("Send ticket:", ticket)

  // Get session state
  const state = service.getSessionState("conv-123")
  console.log("Session state:", state)

  // Subscribe to state changes
  const unsubscribe = service.subscribeSessionState("conv-123", (newState) => {
    console.log("State changed:", newState)
  })

  // Later: cleanup
  unsubscribe()
  service.releaseSession("conv-123")
}
