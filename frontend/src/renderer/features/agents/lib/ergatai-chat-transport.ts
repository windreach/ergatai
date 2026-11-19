import i18n from "@/lib/i18n"
import { conversationRuntimeAgentStorage } from "./conversation-runtime-agent-storage"
/**
 * ErgataiChatTransport — streams chat through the Rust ergatai backend.
 *
 * Flow:
 *   1. GET  /api/v1/agents/:agentId/stream  (subscribe first; wait for stream_ready)
 *   2. POST /api/v1/agents/:agentId/prompt  (fire-and-forget, sends prompt)
 *   3. Transform AgentOutputEvent → UIMessageChunk → ReadableStream
 *   4. On abort → POST /api/v1/agents/:agentId/cancel
 *
 * This is the ONLY production transport — all chat traffic goes through the
 * Rust backend (ergatai-api) which routes to ACP agent processes.
 */

import type { ChatTransport, UIMessage, UIMessageChunk } from "ai"
import { getOrCreateActiveAgent } from "./ergatai-agent-manager"
import { getQueryClient } from "../../../contexts/TRPCProvider"
import { trpcClient } from "../../../lib/trpc"
import { useAgentConversationStore } from "../stores/conversation-store"
import { updateExtensionMeta } from "./extension-meta-store"
import {
  appendSubagentMessage,
  upsertSubagentRun,
  updateSubagentRunState,
  clearSubagentState,
} from "./subagent-message-store"
import { getRuntimeSessionStore } from "../../conversation"
import type { AgentOutputEvent } from "../../../../main/lib/ergatai/sse-client"
import { appStore } from "../../../lib/jotai-store"
import { agentStatusLineAtom } from "../atoms"
import { isPersistedMessageId } from "../../../../shared/id"
import { promptToTitle, mentionsToReadableText } from "../../../../shared/mention-title"
import { normalizeChatError } from "../../../../shared/chat-error"

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

// ── Message part types ──
type TextPart = {
  type: "text"
  text: string
}

type FileContentPart = {
  type: "file-content"
  filePath?: string
  content: string
}

type DataImagePart = {
  type: "data-image"
  data: {
    base64Data: string
    mediaType: string
    filename?: string
  }
}

type DataFilePart = {
  type: "data-file"
  data: {
    base64Data: string
    mediaType?: string
    filename: string
    size?: number
  }
}

type MessagePart = TextPart | FileContentPart | DataImagePart | DataFilePart | { type: string; [key: string]: unknown }

// ── sendMessage response shape (from Rust /api/v1/agents/:id/send) ──
type _SendMessageResult = {
  status: "queued" | "direct_delivered" | "rejected"
  target_agent_id?: string
  session_id?: string
  sequence?: number
  reused?: boolean
  spawned?: boolean
  reason?: string
}



type Unsubscribable = {
  unsubscribe(): void
}

/** How long to wait for the backend stream handshake before sending a prompt. */
const STREAM_READY_TIMEOUT_MS = 2_000

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

    case "status":
      return [{ type: "text-delta", id: textBlockId, delta: event.message + "\n" }]

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

    case "context_usage":
      // Context usage is handled separately in onData callback for UI animation
      return []

    case "done":
      return [{ type: "finish" }]

    case "error": {
      const error = normalizeChatError({
        message: event.message,
        errorName: event.error_name,
        errorType: event.error_type,
        service: event.service,
        code: event.code,
        data: event.error_data,
      })
      console.log("[ErgataiChatTransport][transformEvent] mapped error event", {
        event,
        error,
      })
      return [
        {
          type: "error",
          errorText: error.message,
          // Preserve the structured payload for the renderer. AI SDK's chunk
          // type only declares `errorText`, but the extra field is carried
          // through to the message part unchanged.
          error,
        } as unknown as UIMessageChunk,
        { type: "finish" },
      ]
    }

    case "extension_update": {
      const kind = event.kind
      const payload = (event.payload ?? {}) as Record<string, unknown>
      const id =
        (typeof payload.id === "string" && payload.id) ||
        (typeof payload.compactionId === "string" && payload.compactionId) ||
        (typeof payload.compaction_id === "string" && payload.compaction_id) ||
        (typeof payload.messageId === "string" && payload.messageId) ||
        (typeof payload.message_id === "string" && payload.message_id) ||
        "compact"
      const status =
        typeof payload.status === "string" ? payload.status.toLowerCase() : ""

      if (kind === "compaction_update" || kind?.startsWith("compaction")) {
        const chunks: UIMessageChunk[] = [
          {
            type: "tool-input-start",
            toolCallId: id,
            toolName: "Compact",
          },
          {
            type: "tool-input-available",
            toolCallId: id,
            toolName: "Compact",
            input: payload,
          },
        ]
        const terminal =
          status === "completed" ||
          status === "complete" ||
          status === "compacted" ||
          status === "failed" ||
          status === "error"
        if (terminal) {
          chunks.push({
            type: "tool-output-available",
            toolCallId: id,
            output:
              status === "failed" || status === "error"
                ? { status: "failed", ...payload }
                : { status: "compacted", ...payload },
          })
        }
        return chunks
      }

      if (kind === "compaction_summary_chunk") {
        const delta =
          (typeof payload.delta === "string" && payload.delta) ||
          (typeof payload.summary === "string" && payload.summary) ||
          (typeof payload.text === "string" && payload.text) ||
          (typeof payload.chunk === "string" && payload.chunk) ||
          ""
        if (!delta) return []
        return [
          {
            type: "tool-input-delta",
            toolCallId: id,
            inputTextDelta: delta,
          },
        ]
      }

      return []
    }

    case "retry":
      // Retry status is rendered by the conversation runtime surface, not as a
      // message part. The transport only needs to ignore it here.
      return []

    default:
      return []
  }
}

// ── Safe metadata extraction ──
// Typed metadata shape used for interrupt/correlation signals. Using `unknown`
// plus explicit checks avoids `as unknown` casts that bypass runtime validation.
type ErgataiMessageMetadata = {
  interrupt?: unknown
  correlationId?: unknown
  [key: string]: unknown
}

/**
 * Safely extract metadata from a UIMessage. Returns `undefined` if the
 * message has no metadata or if the metadata is not a plain object.
 * This replaces unsafe `as unknown` casts with runtime validation.
 */
function extractMessageMetadata(message: UIMessage | undefined): ErgataiMessageMetadata | undefined {
  const raw = message?.metadata
  if (raw === null || raw === undefined) return undefined
  if (typeof raw !== "object") return undefined
  return raw as ErgataiMessageMetadata
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
    const expandedPrompt = prompt
    // Conversation titles are generated from the raw text (before mention
    // tokens are unwrapped) so they stay human-readable.
    const titleSource =
      lastUser?.parts
        ?.filter((part): part is TextPart => part.type === "text" && "text" in part)
        .map((part) => part.text)
        .join("\n") ?? ""
    const images = this.extractImages(lastUser)
    const files = this.extractFiles(lastUser)

    // Phase 19: Extract interrupt flag and correlationId from message metadata
    // Use a typed helper to avoid unsafe `as unknown` casts that bypass runtime validation.
    const metadata = extractMessageMetadata(lastUser)
    const interrupt = metadata?.interrupt === true
    const messageCorrelationId =
      typeof metadata?.correlationId === "string" ? metadata.correlationId : undefined

    // Only a backend-issued message ID is safe for durable deduplication.
    // Normal optimistic messages have local IDs and must omit clientRequestId;
    // the backend will allocate the canonical ID when it persists the message.
    const persistedMessageId = isPersistedMessageId(metadata?.externalMessageId)
      ? metadata.externalMessageId
      : isPersistedMessageId(lastUser?.id)
        ? lastUser.id
        : undefined

    // Use local variable to prevent mutation leaking across calls (HIGH severity bug fix)
    const effectiveCorrelationId = messageCorrelationId || this.config.correlationId

    if (!expandedPrompt && images.length === 0 && files.length === 0) {
      throw new Error(i18n.t('No prompt, images, or files found in last user message'))
    }

    // Stable text block ID for this response turn
    const baseTextBlockId = `text-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const baseReasoningBlockId = `thinking-${baseTextBlockId}`
    let finished = false
    let activeBlock: "text" | "reasoning" | null = null
    let subscription: Unsubscribable | null = null
    const toolCallInputs = new Map<string, string>()
    // Map tool call IDs back to the subagent that owns them, so tool results
    // can be attributed even when the completion event lacks subagent_session_id.
    const subagentToolOwners = new Map<string, string>()
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
            subagentToolOwners.clear()
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

        let notifyStreamReady: (() => void) | null = null
        let streamReadyPromise: Promise<void> = Promise.resolve()

        const openAgentStream = (
          agentId: string,
          conversationId: string,
          promptId?: string,
        ): void => {
          console.log("[ErgataiChatTransport] Subscribing to agent stream", {
            agentId,
            promptId,
          })
          streamReadyPromise = new Promise<void>((resolve) => {
            notifyStreamReady = resolve
          })
          subscription = trpcClient.ergatai.subscribeAgentStream.subscribe(
            {
              agentId,
              promptId,
              conversationId,
            },
            {
              onData: (event) => {
                console.log("[ErgataiChatTransport][subscribeAgentStream] onData", {
                  agentId,
                  promptId,
                  conversationId,
                  type: event.type,
                  ...(event.type === "error" ? { event } : {}),
                })
                if (finished) {
                  return
                }

                // TODO(subagent): temporarily not consumed. Subagent conversation capture disabled.
                // // Capture subagent-attributed conversation chunks into the in-memory subagent buffer.
                // if (event.subagent_session_id) {
                //   if (event.type === "text") {
                //     appendSubagentMessage(agentId, event.subagent_session_id, {
                //       kind: "text",
                //       content: event.delta,
                //       createdAt: Date.now(),
                //     })
                //   } else if (event.type === "thinking") {
                //     appendSubagentMessage(agentId, event.subagent_session_id, {
                //       kind: "thinking",
                //       content: event.delta,
                //       createdAt: Date.now(),
                //     })
                //   } else if (event.type === "tool_call_start") {
                //     subagentToolOwners.set(event.id, event.subagent_session_id)
                //     appendSubagentMessage(agentId, event.subagent_session_id, {
                //       kind: "tool_call",
                //       content: `${event.name ?? "tool"} ${JSON.stringify(event.input ?? {})}`,
                //       createdAt: Date.now(),
                //       toolCallId: event.id,
                //       toolName: event.name ?? "tool",
                //       input: event.input,
                //       state: "pending",
                //     })
                //   }
                // }
                //
                // // Attribute tool errors to the owning subagent even when the
                // // completion event has no subagent_session_id.
                // if (event.type === "tool_call_error") {
                //   const owner = subagentToolOwners.get(event.id)
                //   if (owner) {
                //     appendSubagentMessage(agentId, owner, {
                //       kind: "tool_result",
                //       content: event.error,
                //       createdAt: Date.now(),
                //       toolCallId: event.id,
                //       state: "failed",
                //       output: { error: event.error },
                //     })
                //     subagentToolOwners.delete(event.id)
                //   }
                // }

                // Keep a consumable extension-meta snapshot for UI components.
                if (event.type === "extension_update") {
                  updateExtensionMeta(agentId, event.kind, event.payload)

                  // Claude metadata is diagnostic-only: keep it in debug logs.
                  if (event.kind === "claude_code") {
                    console.debug("[ErgataiChatTransport] claude_code metadata:", event.payload)
                  }

                  // Surface quota details into the existing context usage metrics.
                  if (event.kind === "quota_update" && event.payload && typeof event.payload === "object") {
                    const payload = event.payload as Record<string, unknown>
                    const sessionStore = getRuntimeSessionStore()
                    const session = sessionStore.getSession?.(conversationId)
                    const used = session?.contextUsed ?? 0
                    const size = session?.contextWindow ?? 0
                    sessionStore.updateContextUsage(conversationId, used, size, {
                      inputTokens: typeof payload.input_tokens === "number" ? payload.input_tokens : null,
                      outputTokens: typeof payload.output_tokens === "number" ? payload.output_tokens : null,
                      totalTokens: typeof payload.total_tokens === "number" ? payload.total_tokens : null,
                      cachedInputTokens: typeof payload.cached_input_tokens === "number" ? payload.cached_input_tokens : null,
                      cacheWriteInputTokens: typeof payload.cache_write_input_tokens === "number" ? payload.cache_write_input_tokens : null,
                      reasoningOutputTokens: typeof payload.reasoning_output_tokens === "number" ? payload.reasoning_output_tokens : null,
                      modelUsage: payload.model_usage ?? null,
                    })
                  }
                }

                // The backend sends this only after the SSE response is bridged
                // to a live NATS subscription. Waiting for it prevents the
                // prompt from winning the race against TurnStarted.
                if (event.type === "stream_ready") {
                  notifyStreamReady?.()
                  return
                }

                // TurnStarted is the backend's authoritative turn identity.
                // Carry it onto the local AI SDK assistant projection so the
                // runtime store can merge it with runtime and canonical data.
                if (event.type === "turn_started") {
                  if (event.turn_id) {
                    controller.enqueue({
                      type: "message-metadata",
                      messageMetadata: {
                        turnId: event.turn_id,
                        streamSource: "local-transport",
                      },
                    })
                  }
                  return
                }

                // Handle context_usage event for token counter animation
                if (event.type === "context_usage") {
                  console.log("[ErgataiChatTransport] Received context_usage event:", {
                    used: event.used,
                    size: event.size,
                    conversationId,
                  });
                  // Notify UI to update context usage display
                  // The actual animation is handled by the UI component
                  const sessionStore = getRuntimeSessionStore()
                  sessionStore.updateContextUsage(conversationId, event.used, event.size, {
                    inputTokens: event.input_tokens,
                    outputTokens: event.output_tokens,
                    totalTokens: event.total_tokens,
                    cachedInputTokens: event.cached_input_tokens,
                    cacheWriteInputTokens: event.cache_write_input_tokens,
                    reasoningOutputTokens: event.reasoning_output_tokens,
                    modelUsage: event.model_usage,
                  })
                  return
                }

                // TODO(subagent): temporarily not consumed. Subagent run metadata and
                // message-stream surface disabled.
                // // Keep subagent run metadata in the in-memory rail store.
                // if (event.type === "subagent_spawned") {
                //   upsertSubagentRun(agentId, {
                //     subagentSessionId: event.subagent_session_id,
                //     name: event.name,
                //     task: event.task,
                //     state: "running",
                //     startedAt: Date.now(),
                //     updatedAt: Date.now(),
                //   })
                // }
                //
                // if (event.type === "subagent_state_update") {
                //   updateSubagentRunState(agentId, event.subagent_session_id, event.state)
                // }
                //
                // // Surface subagent spawn/state events in the message stream.
                // if (event.type === "subagent_spawned") {
                //   if (activeBlock === "reasoning") {
                //     controller.enqueue({ type: "reasoning-end", id: getReasoningBlockId() })
                //     activeBlock = null
                //   } else if (activeBlock === "text") {
                //     // keep current text block open to append marker
                //   } else {
                //     textBlockCounter++
                //     controller.enqueue({ type: "text-start", id: getTextBlockId() })
                //     activeBlock = "text"
                //   }
                //   controller.enqueue({
                //     type: "text-delta",
                //     id: getTextBlockId(),
                //     delta: `\n[Subagent spawned: ${event.name} — ${event.task}]\n`,
                //   })
                //   return
                // }
                //
                // if (event.type === "subagent_state_update") {
                //   if (activeBlock !== "text") {
                //     if (activeBlock === "reasoning") {
                //       controller.enqueue({ type: "reasoning-end", id: getReasoningBlockId() })
                //     }
                //     textBlockCounter++
                //     controller.enqueue({ type: "text-start", id: getTextBlockId() })
                //     activeBlock = "text"
                //   }
                //   controller.enqueue({
                //     type: "text-delta",
                //     id: getTextBlockId(),
                //     delta: `\n[Subagent ${event.subagent_session_id} state: ${event.state}]\n`,
                //   })
                //   return
                // }

                // Phase 19: Handle message_inserted event for interrupt queue management
                if (event.type === "message_inserted") {
                  // Notify TurnOrchestrator to remove the message from queue
                  // The message has been successfully inserted at a safe point
                  const sessionStore = getRuntimeSessionStore()
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

                const isCompactionExtension =
                  event.type === "extension_update" &&
                  (event.kind === "compaction_update" ||
                    String(event.kind ?? "").startsWith("compaction"))

                if (isCompactionExtension) {
                  if (activeBlock === "reasoning") {
                    controller.enqueue({ type: "reasoning-end", id: getReasoningBlockId() })
                    activeBlock = null
                  } else if (activeBlock === "text") {
                    controller.enqueue({ type: "text-end", id: getTextBlockId() })
                    activeBlock = null
                  }
                }

                if (event.type === "tool_call_start") {
                  // Close any active reasoning/text block before starting a tool call.
                  // Without this, if thinking finishes and a tool_call_start arrives
                  // (with no text in between), the reasoning block stays in
                  // "input-streaming" state and the UI keeps showing "Thinking..."
                  // with a ticking counter until text appears or the stream ends.
                  if (activeBlock === "reasoning") {
                    controller.enqueue({ type: "reasoning-end", id: getReasoningBlockId() })
                    activeBlock = null
                  } else if (activeBlock === "text") {
                    controller.enqueue({ type: "text-end", id: getTextBlockId() })
                    activeBlock = null
                  }
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

                  // TODO(subagent): temporarily not consumed. Subagent tool-result attribution disabled.
                  // // Attribute tool results back to the owning subagent, if any.
                  // const owner = subagentToolOwners.get(event.id)
                  // if (owner) {
                  //   appendSubagentMessage(agentId, owner, {
                  //     kind: "tool_result",
                  //     content:
                  //       typeof event.output === "string"
                  //         ? event.output
                  //         : JSON.stringify(event.output ?? ""),
                  //     createdAt: Date.now(),
                  //     toolCallId: event.id,
                  //     state: "completed",
                  //     output: event.output,
                  //   })
                  //   subagentToolOwners.delete(event.id)
                  // }
                }

                // Handle session title update separately
                if (event.type === "session_title_update") {
                  const titleChanged = lastSessionTitle !== event.title
                  if (titleChanged) {
                    lastSessionTitle = event.title
                    // Agents can echo the first prompt as the session title;
                    // strip any serialized mention tokens before persisting it.
                    const readableTitle =
                      mentionsToReadableText(event.title) || event.title

                    // Update conversation title in backend only when it changes
                    trpcClient.ergatai.updateConversation
                      .mutate({
                        conversationId,
                        title: readableTitle,
                      })
                      .then(() => {
                        // Also update in-memory store so UI reflects the change immediately
                        useAgentConversationStore.getState().updateConversationName(
                          conversationId,
                          readableTitle,
                        )
                      })
                      .catch(() => {
                        // Silently fail - title update is not critical
                      })
                  }
                  return
                }

                if (event.type === "status") {
                  console.log("[ErgataiChatTransport] received status event:", event.message)
                  // Render agent stderr/status lines directly in the chat stream.
                  appStore.set(agentStatusLineAtom, event.message)
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

                  if ((event.type === "text" || event.type === "status") && activeBlock !== "text") {
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
                    errorText: error instanceof Error ? error.message : i18n.t('SSE connection lost'),
                  },
                  { type: "finish" },
                ])
              },
              onComplete: () => {
                close([{ type: "finish" }])
              },
            },
          )
        }

        if (options.abortSignal?.aborted) {
          handleAbort()
          return
        }
        options.abortSignal?.addEventListener("abort", handleAbort, { once: true })

        void (async () => {
          try {
            // Resolve agentId — use config value, or dynamically get/create one
            // Use local variables to avoid mutating shared this.config (race condition fix)
            let effectiveAgentId = this.config.agentId
            let effectiveConversationId = this.config.conversationId
            if (!effectiveAgentId) {
              effectiveAgentId = await getOrCreateActiveAgent(
                this.config.chatId,
                this.config.command,
                effectiveConversationId
              )
            }

            if (!effectiveAgentId) {
              throw new Error(i18n.t('Agent ID is not available — cannot send message'))
            }

            // Model detection is now handled by the backend.
            // Use `refreshAgentProfileModels` tRPC mutation to trigger model detection.
            // The useAvailableModels hook reads from the backend DB automatically.

            const isAgentToAgent = !!this.config.fromAgentId

            // Lazily create conversation on first message
            // This follows the principle: "create less, reuse more"
            if (!effectiveConversationId) {
              console.log("[ErgataiChatTransport] Lazily creating conversation for chat:", this.config.chatId)

              // Check if there's already a creation in progress for this chat
              const existingPromise = ErgataiChatTransport.conversationCreationPromises.get(this.config.chatId)

              if (existingPromise) {
                // Wait for the in-progress creation to complete
                console.log("[ErgataiChatTransport] Waiting for ongoing conversation creation")
                effectiveConversationId = await existingPromise
                console.log("[ErgataiChatTransport] Reusing conversation from ongoing creation:", effectiveConversationId)
              } else {
                // Create conversation with concurrency control
                // The list-and-create sequence is now inside the promise to serialize it per chatId (TOCTOU fix)
                const creationPromise = (async () => {
                  try {
                    // Check if conversation already exists for this chat (inside promise for serialization)
                    const conversations = await trpcClient.ergatai.listConversations.query({
                      chatId: this.config.chatId,
                    })

                    if (conversations.length > 0) {
                      // Reuse existing conversation
                      console.log("[ErgataiChatTransport] Reusing conversation:", conversations[0].id)
                      return conversations[0].id
                    }

                    // Create new conversation
                    const conversation = await trpcClient.ergatai.createConversation.mutate({
                      chatId: this.config.chatId,
                      title: promptToTitle(titleSource) || i18n.t('New Conversation'),
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
                effectiveConversationId = await creationPromise
                console.log("[ErgataiChatTransport] Created conversation:", effectiveConversationId)
              }
            }

            // Remember which runtime agent is serving this conversation so that
            // Stop/cancel can target it without guessing from chat bindings.
            if (effectiveConversationId && effectiveAgentId) {
              conversationRuntimeAgentStorage.set(effectiveConversationId, effectiveAgentId)
            }

            // Open the conversation-wide stream before publishing the prompt.
            // The backend emits stream_ready only after NATS subscribers exist,
            // so TurnStarted can no longer be emitted before this transport
            // has attached.
            openAgentStream(effectiveAgentId, effectiveConversationId)
            try {
              let streamReadyTimer: ReturnType<typeof setTimeout> | null = null
              await Promise.race([
                streamReadyPromise,
                new Promise<null>((resolve) => {
                  streamReadyTimer = setTimeout(() => resolve(null), STREAM_READY_TIMEOUT_MS)
                }),
              ])
              if (streamReadyTimer) {
                clearTimeout(streamReadyTimer)
              }
            } catch {
              // A transport error will close the stream; still let prompt
              // errors surface in the normal try/catch below.
            }

            if (isAgentToAgent) {
              // Agent-to-agent communication
              // Reuse an already-persisted message ID when available (for
              // example, auto-triggering a message written by chats.create).
              // Otherwise omit the ID and let the backend assign its canonical
              // Snowflake message ID.
              const clientRequestId = persistedMessageId
              await trpcClient.ergatai.sendMessage.mutate({
                agentId: effectiveAgentId,
                message: expandedPrompt,
                from: this.config.fromAgentId,
                messageType: "request",
                targetAgentCommand: this.config.targetAgentCommand,
                forceNewSession: this.config.forceNewSession,
                correlationId: effectiveCorrelationId,
                conversationId: effectiveConversationId,
                clientRequestId,
              })
            } else {
              // Reuse an already-persisted message ID when available. For a new
              // optimistic message, let the backend assign the canonical ID; do
              // not create frontend UUIDs for durable message metadata.
              const clientRequestId = persistedMessageId
              const promptResult = await trpcClient.ergatai.promptAgent.mutate({
                agentId: effectiveAgentId,
                message: expandedPrompt,
                conversationId: effectiveConversationId,
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
              if (
                promptResult?.new_agent_id &&
                promptResult.new_agent_id !== effectiveAgentId
              ) {
                // The backend replaced a suspended runtime ID with a new live ID.
                // Refresh durable bindings and status stores so UI controls target
                // the current process on subsequent sends/stops.
                this.config.agentId = promptResult.new_agent_id
                effectiveAgentId = promptResult.new_agent_id
                if (effectiveConversationId) {
                  conversationRuntimeAgentStorage.set(effectiveConversationId, promptResult.new_agent_id)
                }
                const queryClient = getQueryClient()
                queryClient?.invalidateQueries({
                  queryKey: [["ergatai", "getAgentBindings"]],
                })
                queryClient?.invalidateQueries({
                  queryKey: [["ergatai", "listAgents"]],
                })
              }
            }
          } catch (error) {
            console.error("[ErgataiTransport] Failed to start agent:", error)
            close([
              {
                type: "error",
                errorText: error instanceof Error ? error.message : i18n.t('Failed to start agent'),
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

    // Simple string content (legacy format)
    if (typeof (message as unknown as { content?: string }).content === "string") {
      return (message as unknown as { content: string }).content
    }

    if (!message.parts) return ""

    const textParts: string[] = []
    const fileContents: string[] = []
    const parts = message.parts as MessagePart[]

    for (const part of parts) {
      if (part.type === "text" && "text" in part) {
        const textPart = part as TextPart
        if (textPart.text) {
          // Ergatai mention tokens (e.g. @[file:...], @[agent:...], $[...])
          // are a UI serialization format. Keep them verbatim here so the raw
          // prompt is stored and can be re-rendered as mention chips; the
          // backend converts them to agent-native text at delivery time
          // (see initial_prompt_turns::convert_prompt_tokens).
          const raw = textPart.text.trim()
          if (raw) {
            textParts.push(raw)
          }
        }
      } else if (part.type === "file-content" && "content" in part) {
        const filePart = part as FileContentPart
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
    const parts = message.parts as MessagePart[]

    for (const part of parts) {
      if (part.type === "data-image" && "data" in part) {
        const dataPart = part as DataImagePart
        const data = dataPart.data
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
    const parts = message.parts as MessagePart[]

    for (const part of parts) {
      if (part.type === "data-file" && "data" in part) {
        const dataPart = part as DataFilePart
        const data = dataPart.data
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