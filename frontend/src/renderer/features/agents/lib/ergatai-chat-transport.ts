/**
 * ErgataiChatTransport — streams chat through the Rust ergatai backend.
 *
 * Flow:
 *   1. POST /api/v1/agents/:agentId/prompt  (fire-and-forget, sends prompt)
 *   2. GET  /api/v1/agents/:agentId/stream   (SSE — real-time events)
 *   3. Transform AgentOutputEvent → UIMessageChunk → ReadableStream
 *   4. On abort → POST /api/v1/agents/:agentId/cancel
 *
 * This is the ONLY production transport — all chat traffic goes through the
 * Rust backend (ergatai-api) which routes to ACP agent processes.
 */

import type { ChatTransport, UIMessage } from "ai"
import { getOrCreateActiveAgent, fetchAgentModels } from "./ergatai-agent-manager"
import { trpcClient } from "../../../lib/trpc"
import { useAgentConversationStore } from "../stores/conversation-store"
import { getRuntimeSessionStore } from "../../conversation/runtime/runtime-session-store"

type UIMessageChunk = any

// ── Rust backend event types (snake_case JSON) ──

type ToolCallLocation = {
  path: string
  line?: number
}

type ToolCallEventData = {
  id: string
  name: string
  input?: unknown
  output?: unknown
  locations?: ToolCallLocation[]
}

type AgentOutputEvent =
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | ({ type: "tool_call_start" } & ToolCallEventData)
  | { type: "tool_call_input"; id: string; delta: string }
  | ({ type: "tool_call_complete" } & ToolCallEventData)
  | { type: "tool_call_error"; id: string; error: string }
  | { type: "session_title_update"; title: string }
  | { type: "subagent_spawned"; role?: string | null; subagent_session_id: string; name: string; task: string }
  | { type: "subagent_state_update"; role?: string | null; subagent_session_id: string; state: string }
  | {
      type: "conversation_message"
      message_id: string
      role: string
      message_type?: string | null
      content: string
      parts?: unknown
      metadata?: unknown
      timestamp_ms: number
      sender_agent_id?: string | null
      sender_agent_name?: string | null
    }
  | { type: "done"; stop_reason: string }
  | { type: "turn_started"; role?: string | null }
  | { type: "error"; message: string }

type ErgataiChatTransportConfig = {
  chatId: string
  conversationId: string
  agentId?: string  // Optional — auto-resolved via agent manager if not provided
  workspaceId?: string  // Used for auto-spawn when no agent exists
  command?: string  // Agent command to spawn (default: "claude")
  mode: "plan" | "agent"
  // Agent-to-agent communication fields
  fromAgentId?: string  // When this transport is used by an agent (not user)
  targetAgentCommand?: string  // Target agent type for routing
  forceNewSession?: boolean  // Force spawn new session
  correlationId?: string  // Track cross-agent conversations
}

// ── Image attachment ──
type ImageAttachment = {
  base64Data: string
  mediaType: string
  filename?: string
}

// ── File attachment ──
type FileAttachment = {
  base64Data: string
  mediaType?: string
  filename: string
  size?: number
}

type Unsubscribable = {
  unsubscribe(): void
}

function parseStreamedToolInput(value: string | undefined): Record<string, unknown> | null {
  if (!value) return null

  try {
    const input = JSON.parse(value)
    return input && typeof input === "object" && !Array.isArray(input)
      ? input as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function mergeToolInput(event: ToolCallEventData): Record<string, unknown> {
  const input: Record<string, unknown> = event.input && typeof event.input === "object" && !Array.isArray(event.input)
    ? { ...(event.input as Record<string, unknown>) }
    : {}
  if (event.locations && event.locations.length > 0) {
    input._locations = event.locations
  } else if (event.name === "Edit" || event.name === "Write") {
    const filePath = input.file_path || input.path || input.file
    if (typeof filePath === "string") {
      input._locations = [{ path: filePath }]
    }
  }
  return input
}

/**
 * Transform a Rust AgentOutputEvent into one or more UIMessageChunk values.
 */
function transformEvent(
  event: AgentOutputEvent,
  textBlockId: string,
  reasoningBlockId: string = `thinking-${textBlockId}`,
): UIMessageChunk[] {
  switch (event.type) {
    case "text":
      return [{ type: "text-delta", id: textBlockId, delta: event.delta }]

    case "thinking":
      return [
        {
          type: "reasoning-delta",
          id: reasoningBlockId,
          delta: event.delta,
        },
      ]

    case "tool_call_start": {
      const chunks: UIMessageChunk[] = [
        {
          type: "tool-input-start",
          toolCallId: event.id,
          toolName: event.name || "unknown",
        },
      ]
      if (event.input != null) {
        chunks.push({
          type: "tool-input-available",
          toolCallId: event.id,
          toolName: event.name || "unknown",
          input: mergeToolInput(event),
        })
      }
      return chunks
    }

    case "tool_call_input":
      return [
        {
          type: "tool-input-delta",
          toolCallId: event.id,
          inputTextDelta: event.delta,
        },
      ]

    case "tool_call_complete":
      return [
        {
          type: "tool-input-available",
          toolCallId: event.id,
          toolName: event.name || "unknown",
          input: mergeToolInput(event),
        },
        {
          type: "tool-output-available",
          toolCallId: event.id,
          output: event.output ?? "",
        },
      ]

    case "tool_call_error":
      return [
        {
          type: "tool-output-error",
          toolCallId: event.id,
          errorText: event.error,
        },
      ]

    case "session_title_update":
      // Session title update is handled separately in onData callback
      // Not a message content, so return empty array
      return []

    case "done":
      return [{ type: "finish" }]

    case "error":
      return [
        { type: "error", errorText: event.message },
        { type: "finish" },
      ]

    default:
      return []
  }
}

export class ErgataiChatTransport implements ChatTransport<UIMessage> {
  // Static cache to prevent concurrent conversation creation for the same chat
  private static conversationCreationPromises = new Map<string, Promise<string>>()

  constructor(private config: ErgataiChatTransportConfig) {}

  async sendMessages(options: {
    messages: UIMessage[]
    abortSignal?: AbortSignal
  }): Promise<ReadableStream<UIMessageChunk>> {
    // Extract prompt from last user or agent message (text + file content + images)
    // Support both "user" (normal chat) and "agent" (agent-to-agent) roles
    const lastUser = [...options.messages]
      .reverse()
      .find((m) => m.role === "user" || (m.role as string) === "agent")
    const prompt = this.extractPrompt(lastUser)
    const images = this.extractImages(lastUser)
    const files = this.extractFiles(lastUser)

    // Phase 19: Extract interrupt flag and correlationId from message metadata
    const interrupt = (lastUser as any)?.metadata?.interrupt ?? false
    const messageCorrelationId = (lastUser as any)?.metadata?.correlationId

    // Update config.correlationId if provided in message metadata (for interrupt queue matching)
    if (messageCorrelationId) {
      this.config.correlationId = messageCorrelationId
    }

    if (!prompt && images.length === 0 && files.length === 0) {
      throw new Error("No prompt, images, or files found in last user message")
    }

    // Stable text block ID for this response turn
    const baseTextBlockId = `text-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const baseReasoningBlockId = `thinking-${baseTextBlockId}`
    let finished = false
    let activeBlock: "text" | "reasoning" | null = null
    let subscription: Unsubscribable | null = null
    const toolCallInputs = new Map<string, string>()
    // Track block ID counters for generating unique IDs on each switch
    let textBlockCounter = 0
    let reasoningBlockCounter = 0
    const getTextBlockId = () => textBlockCounter === 0 ? baseTextBlockId : `${baseTextBlockId}-${textBlockCounter}`
    const getReasoningBlockId = () => reasoningBlockCounter === 0 ? baseReasoningBlockId : `${baseReasoningBlockId}-${reasoningBlockCounter}`

    // Frontend dual counting for session title updates
    let lastSessionTitle: string | null = null

    return new ReadableStream<UIMessageChunk>({
      start: (controller) => {
        // Return the stream immediately so the UI has feedback while the
        // agent process is being spawned and the prompt is being submitted.
        controller.enqueue({ type: "start" })

        const close = (chunks: UIMessageChunk[] = []) => {
          if (!finished) {
            finished = true
            if (activeBlock === "reasoning") {
              controller.enqueue({ type: "reasoning-end", id: getReasoningBlockId() })
            }
            if (activeBlock === "text") {
              controller.enqueue({ type: "text-end", id: getTextBlockId() })
            }
            subscription?.unsubscribe()
            for (const chunk of chunks) {
              controller.enqueue(chunk)
            }
            controller.close()
          }
        }

        const handleAbort = () => {
          if (finished) return
          // Backend cancel API is called by service.stop() - unified entry point
          // Transport layer should NOT call cancelPrompt here to avoid duplicate calls
          close([{ type: "finish" }])
        }

        if (options.abortSignal?.aborted) {
          handleAbort()
          return
        }
        options.abortSignal?.addEventListener("abort", handleAbort, { once: true })

        void (async () => {
          try {
            // Resolve agentId — use config value, or dynamically get/create one
            let { agentId } = this.config
            if (!agentId) {
              agentId = await getOrCreateActiveAgent(
                this.config.chatId,
                this.config.command,
                this.config.conversationId
              )
              // Update config for subsequent calls and abort handling.
              this.config.agentId = agentId
            }

            if (!agentId) {
              throw new Error("Agent ID is not available — cannot send message")
            }

            // Fetch models from agent using two-tier fallback:
            // 1. PRIMARY: ACP config_options (standard protocol approach)
            // 2. FALLBACK: Spawn temporary agent and execute /model command (for agents that don't support config_options)
            // Models are written to the Jotai atom asynchronously; UI updates when ready.
            fetchAgentModels(agentId, this.config.command, undefined, this.config.conversationId)

            // Determine message payload based on message type
            let promptId: string | null = null
            const isAgentToAgent = !!this.config.fromAgentId

            // Lazily create conversation on first message
            // This follows the principle: "create less, reuse more"
            if (!this.config.conversationId) {
              console.log("[ErgataiChatTransport] Lazily creating conversation for chat:", this.config.chatId)

              // Check if there's already a creation in progress for this chat
              const existingPromise = ErgataiChatTransport.conversationCreationPromises.get(this.config.chatId)

              if (existingPromise) {
                // Wait for the in-progress creation to complete
                console.log("[ErgataiChatTransport] Waiting for ongoing conversation creation")
                this.config.conversationId = await existingPromise
                console.log("[ErgataiChatTransport] Reusing conversation from ongoing creation:", this.config.conversationId)
              } else {
                // Check if conversation already exists for this chat
                const conversations = await trpcClient.ergatai.listConversations.query({
                  chatId: this.config.chatId,
                })

                if (conversations.length > 0) {
                  // Reuse existing conversation
                  this.config.conversationId = conversations[0].id
                  console.log("[ErgataiChatTransport] Reusing conversation:", this.config.conversationId)
                } else {
                  // Create new conversation with concurrency control
                  const creationPromise = (async () => {
                    try {
                      const conversation = await trpcClient.ergatai.createConversation.mutate({
                        chatId: this.config.chatId,
                        title: prompt?.slice(0, 50) || "New Conversation",
                        mode: this.config.mode,
                      })
                      return conversation.id
                    } finally {
                      // Clean up the promise cache after completion
                      ErgataiChatTransport.conversationCreationPromises.delete(this.config.chatId)
                    }
                  })()

                  // Store the promise in cache
                  ErgataiChatTransport.conversationCreationPromises.set(this.config.chatId, creationPromise)

                  // Wait for creation to complete
                  this.config.conversationId = await creationPromise
                  console.log("[ErgataiChatTransport] Created conversation:", this.config.conversationId)
                }
              }
            }

            if (isAgentToAgent) {
              // Agent-to-agent communication
              // Generate clientRequestId for optimistic → durable replacement
              const clientRequestId = crypto.randomUUID()
              const result = await trpcClient.ergatai.sendMessage.mutate({
                agentId,
                message: prompt,
                from: this.config.fromAgentId,
                messageType: "request",
                targetAgentCommand: this.config.targetAgentCommand,
                forceNewSession: this.config.forceNewSession,
                correlationId: this.config.correlationId,
                conversationId: this.config.conversationId,
                clientRequestId,
              })
              // Try to extract prompt_id from response if available
              promptId = (result as any)?.prompt_id ?? (result as any)?.stream ?? null
            } else {
              // Generate clientRequestId for optimistic → durable replacement
              // Use config.correlationId if provided (for interrupt queue matching), otherwise generate new
              const clientRequestId = this.config.correlationId ?? crypto.randomUUID()
              const promptResult = await trpcClient.ergatai.promptAgent.mutate({
                agentId,
                message: prompt,
                conversationId: this.config.conversationId,
                images: images.map((image) => ({
                  base64Data: image.base64Data,
                  mediaType: image.mediaType,
                  filename: image.filename,
                })),
                files: files.map((file) => ({
                  base64Data: file.base64Data,
                  mediaType: file.mediaType,
                  filename: file.filename,
                  size: file.size,
                })),
                waitForStream: true,
                clientRequestId,
                interrupt,  // Phase 19: Pass interrupt flag to backend
              })
              promptId = promptResult.prompt_id

              // Phase 19: Store clientRequestId in last message metadata for queue matching
              if (interrupt && lastUser) {
                ;(lastUser as any).metadata = {
                  ...(lastUser as any).metadata,
                  clientRequestId,
                }
              }
            }

            console.log("[ErgataiChatTransport] Subscribing to agent stream", {
              agentId,
              promptId,
              conversationId: this.config.conversationId,
            })

            subscription = trpcClient.ergatai.subscribeAgentStream.subscribe(
              {
                agentId,
                promptId: promptId ?? undefined,
              },
              {
                onData: (event) => {
                  if (finished) {
                    return
                  }

                  // Phase 19: Handle message_inserted event for interrupt queue management
                  if (event.type === "message_inserted") {
                    // Notify TurnOrchestrator to remove the message from queue
                    // The message has been successfully inserted at a safe point
                    const sessionStore = getRuntimeSessionStore()
                    const conversationId = this.config.conversationId

                    // Find and remove the queue item by clientRequestId
                    // Store clientRequestId in queue item's transportOverrides for matching
                    const session = sessionStore.getSession(conversationId)
                    if (session && event.client_request_id) {
                      const queueItem = session.queue.find(
                        (item) => item.originalInput.transportOverrides?.correlationId === event.client_request_id
                      )
                      if (queueItem) {
                        sessionStore.removeQueueItem(conversationId, queueItem.id)
                        console.log("[ErgataiChatTransport] Message inserted at safe point, removed from queue:", event.client_request_id)
                      }
                    }
                    return
                  }

                  if (event.type === "tool_call_start") {
                    toolCallInputs.set(event.id, "")
                  } else if (event.type === "tool_call_input") {
                    toolCallInputs.set(
                      event.id,
                      (toolCallInputs.get(event.id) ?? "") + event.delta,
                    )
                  }

                  let streamEvent = event
                  if (event.type === "tool_call_complete") {
                    const finalInput =
                      event.input && typeof event.input === "object" && !Array.isArray(event.input)
                        ? event.input as Record<string, unknown>
                        : null
                    const streamedInput = parseStreamedToolInput(toolCallInputs.get(event.id))
                    const input = finalInput && Object.keys(finalInput).length > 0
                      ? { ...streamedInput, ...finalInput }
                      : streamedInput
                    streamEvent = { ...event, input: input ?? undefined }
                    // Clean up the Map entry to prevent memory leak
                    toolCallInputs.delete(event.id)
                  }

                  // Handle session title update separately
                  if (event.type === "session_title_update") {
                    const titleChanged = lastSessionTitle !== event.title
                    if (titleChanged) {
                      lastSessionTitle = event.title

                      // Update conversation title in backend only when it changes
                      trpcClient.ergatai.updateConversation
                        .mutate({
                          conversationId: this.config.conversationId,
                          title: event.title,
                        })
                        .then(() => {
                          // Also update in-memory store so UI reflects the change immediately
                          useAgentConversationStore.getState().updateConversationName(
                            this.config.conversationId,
                            event.title
                          )
                        })
                        .catch(() => {
                          // Silently fail - title update is not critical
                        })
                    }
                    return
                  }

                  if (event.type === "done" || event.type === "error") {
                    // Let close() handle the closing of text/reasoning blocks
                    close([...transformEvent(event, getTextBlockId(), getReasoningBlockId())])
                  } else {
                    if (event.type === "thinking" && activeBlock !== "reasoning") {
                      if (activeBlock === "text") {
                        controller.enqueue({ type: "text-end", id: getTextBlockId() })
                      }
                      reasoningBlockCounter++
                      controller.enqueue({ type: "reasoning-start", id: getReasoningBlockId() })
                      activeBlock = "reasoning"
                    }

                    if (event.type === "text" && activeBlock !== "text") {
                      if (activeBlock === "reasoning") {
                        controller.enqueue({ type: "reasoning-end", id: getReasoningBlockId() })
                      }
                      textBlockCounter++
                      controller.enqueue({ type: "text-start", id: getTextBlockId() })
                      activeBlock = "text"
                    }

                    const chunks = transformEvent(streamEvent, getTextBlockId(), getReasoningBlockId())
                    for (const chunk of chunks) {
                      controller.enqueue(chunk)
                    }
                  }
                },
                onError: (error) => {
                  console.error("[ErgataiTransport] SSE error:", error)
                  close([
                    {
                      type: "error",
                      errorText: error instanceof Error ? error.message : "SSE connection lost",
                    },
                    { type: "finish" },
                  ])
                },
                onComplete: () => {
                  close([{ type: "finish" }])
                },
              },
            )
          } catch (error) {
            console.error("[ErgataiTransport] Failed to start agent:", error)
            close([
              {
                type: "error",
                errorText: error instanceof Error ? error.message : "Failed to start agent",
              },
              { type: "finish" },
            ])
          }
        })()
      },
      cancel: () => {
        if (!finished) {
          // Backend cancel API is called by service.stop() - unified entry point
          // Transport layer should NOT call cancelPrompt here to avoid duplicate calls
        }
        subscription?.unsubscribe()
        finished = true
      },
    })
  }

  async reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    return null
  }

  cleanup(): void {
    // No-op — no persistent session to clean up on the backend
  }

  // ── Prompt extraction ──

  /**
   * Extract prompt text from a UIMessage, including file content parts.
   */
  private extractPrompt(message: UIMessage | undefined): string {
    if (!message) return ""

    // Simple string content
    if (typeof (message as any).content === "string") {
      return (message as any).content as string
    }

    if (!message.parts) return ""

    const textParts: string[] = []
    const fileContents: string[] = []

    for (const part of message.parts) {
      const partType = (part as any).type
      if (partType === "text" && (part as any).text) {
        textParts.push((part as any).text)
      } else if (partType === "file-content") {
        const filePart = part as any
        const fileName =
          filePart.filePath?.split("/").pop() || filePart.filePath || "file"
        fileContents.push(`\n--- ${fileName} ---\n${filePart.content}`)
      }
    }

    return textParts.join("\n") + fileContents.join("")
  }

  /**
   * Extract image attachments from a UIMessage.
   */
  private extractImages(message: UIMessage | undefined): ImageAttachment[] {
    if (!message?.parts) return []

    const images: ImageAttachment[] = []

    for (const part of message.parts) {
      if (part.type === "data-image" && (part as any).data) {
        const data = (part as any).data
        if (data.base64Data && data.mediaType) {
          images.push({
            base64Data: data.base64Data,
            mediaType: data.mediaType,
            filename: data.filename,
          })
        }
      }
    }

    return images
  }

  /**
   * Extract file attachments from a UIMessage.
   */
  private extractFiles(message: UIMessage | undefined): FileAttachment[] {
    if (!message?.parts) return []

    const files: FileAttachment[] = []

    for (const part of message.parts) {
      if (part.type === "data-file" && (part as any).data) {
        const data = (part as any).data
        if (data.base64Data && data.filename) {
          files.push({
            base64Data: data.base64Data,
            mediaType: data.mediaType,
            filename: data.filename,
            size: data.size,
          })
        }
      }
    }

    return files
  }
}

/**
 * Create a transport for user-to-agent communication (normal chat).
 */
export function createUserChatTransport(
  chatId: string,
  conversationId: string,
  options: {
    agentId?: string
    command?: string
    mode?: "plan" | "agent"
  } = {}
): ErgataiChatTransport {
  return new ErgataiChatTransport({
    chatId,
    conversationId,
    agentId: options.agentId,
    command: options.command,
    mode: options.mode || "agent",
  })
}

/**
 * Create a transport for agent-to-agent communication.
 * Used when an agent needs to send messages to another agent through the chat interface.
 */
export function createAgentToAgentTransport(
  chatId: string,
  conversationId: string,
  fromAgentId: string,
  options: {
    targetAgentCommand?: string
    forceNewSession?: boolean
    correlationId?: string
    mode?: "plan" | "agent"
  } = {}
): ErgataiChatTransport {
  return new ErgataiChatTransport({
    chatId,
    conversationId,
    fromAgentId,
    targetAgentCommand: options.targetAgentCommand,
    forceNewSession: options.forceNewSession,
    correlationId: options.correlationId,
    mode: options.mode || "agent",
  })
}
