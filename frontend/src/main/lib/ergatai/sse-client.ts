import { z } from "zod"
import { getErgataiAuthConfig } from "./api"
import type { BackendMessage, BackendSseMessage } from "./user-data"
import { createLogger } from "../logger"

const log = createLogger("SSE")

// ============================================================================
// GENERIC SSE STREAM PARSER - Shared infrastructure
// ============================================================================

/**
 * Generic SSE stream parser that handles connection, buffering, and event dispatch.
 * Reduces duplication across multiple SSE subscription functions.
 *
 * @param url - SSE endpoint URL
 * @param onEvent - Callback for each parsed event (raw SSE event string)
 * @param onError - Optional error callback
 * @param onComplete - Optional completion callback
 * @returns Cleanup function to abort the stream
 */
function createSseStream(
  url: string,
  onEvent: (rawEvent: string) => void,
  onError?: (error: Error) => void,
  onComplete?: () => void,
): () => void {
  const { apiUrl, token } = getErgataiAuthConfig()
  const controller = new AbortController()
  let cleanedUp = false

  const cleanup = () => {
    if (cleanedUp) return
    cleanedUp = true
    controller.abort()
    onComplete?.()
  }

  void (async () => {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: "text/event-stream",
          Authorization: `Bearer ${token}`,
        },
        signal: controller.signal,
      })

      if (!response.ok) {
        const detail = await response.text().catch(() => "unknown error")
        throw new Error(`SSE request failed: ${response.status} ${detail.trim()}`)
      }

      if (!response.body) {
        throw new Error("SSE response has no readable body")
      }

      let buffer = ""
      const reader = response.body.getReader()
      const decoder = new TextDecoder()

      while (!cleanedUp) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        // Normalize line endings: convert \r\n and \r to \n
        buffer = buffer.replace(/\r\n|\r/g, "\n")

        // Parse complete events (separated by double newline)
        while (true) {
          const boundary = buffer.indexOf("\n\n")
          if (boundary === -1) break
          const rawEvent = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          onEvent(rawEvent)
        }
      }

      // Flush any remaining data in the buffer
      buffer += decoder.decode()
      if (buffer.trim()) {
        onEvent(buffer)
      }

      cleanup()
    } catch (error) {
      const hadCleanedUp = cleanedUp
      cleanup()
      if (!hadCleanedUp && !controller.signal.aborted) {
        onError?.(error instanceof Error ? error : new Error("SSE connection failed"))
      }
    }
  })()

  return cleanup
}

/**
 * Parse SSE event fields (event name and data) from raw event string.
 */
function parseSseEventFields(rawEvent: string): { eventName: string; data: string } {
  let eventName = "message"
  let data = ""

  for (const line of rawEvent.split(/\r?\n/)) {
    if (line.startsWith(":")) {
      // SSE comment (often keep-alives) — skip silently in production
      if (process.env.NODE_ENV === "development") {
        log.debug("Comment received", undefined, { line })
      }
      continue
    }

    const colonIndex = line.indexOf(":")
    if (colonIndex === -1) continue

    const field = line.slice(0, colonIndex)
    const value = line.slice(colonIndex + 1)
    const normalizedValue = value.startsWith(" ") ? value.slice(1) : value

    if (field === "event") {
      eventName = normalizedValue
    } else if (field === "data") {
      data += data ? `\n${normalizedValue}` : normalizedValue
    }
  }

  return { eventName, data }
}

/**
 * Zod schema for runtime validation of SSE events.
 * Prevents unsafe type assertions and validates backend data at the trust boundary.
 */
const agentOutputEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), delta: z.string(), conversation_id: z.string().nullish() }),
  z.object({ type: z.literal("thinking"), delta: z.string(), conversation_id: z.string().nullish() }),
  z.object({
    type: z.literal("tool_call_start"),
    id: z.string(),
    name: z.string(),
    input: z.any().optional(),
    output: z.any().optional(),
    locations: z.array(z.object({ path: z.string(), line: z.number().optional() })).optional(),
    conversation_id: z.string().nullish(),
  }),
  z.object({ type: z.literal("tool_call_input"), id: z.string(), delta: z.string(), conversation_id: z.string().nullish() }),
  z.object({
    type: z.literal("tool_call_complete"),
    id: z.string(),
    name: z.string(),
    input: z.any().optional(),
    output: z.any().optional(),
    locations: z.array(z.object({ path: z.string(), line: z.number().optional() })).optional(),
    conversation_id: z.string().nullish(),
  }),
  z.object({ type: z.literal("tool_call_error"), id: z.string(), error: z.string(), conversation_id: z.string().nullish() }),
  z.object({ type: z.literal("session_title_update"), title: z.string(), conversation_id: z.string().nullish() }),
  z.object({
    type: z.literal("subagent_spawned"),
    role: z.string().nullish(),
    subagent_session_id: z.string(),
    name: z.string(),
    task: z.string(),
    conversation_id: z.string().nullish(),
  }),
  z.object({
    type: z.literal("subagent_state_update"),
    role: z.string().nullish(),
    subagent_session_id: z.string(),
    state: z.string(),
    conversation_id: z.string().nullish(),
  }),
  z.object({ type: z.literal("done"), stop_reason: z.string(), conversation_id: z.string().nullish() }),
  z.object({ type: z.literal("turn_started"), role: z.string().nullish(), conversation_id: z.string().nullish() }),
  z.object({ type: z.literal("error"), message: z.string(), conversation_id: z.string().nullish() }),
  z.object({
    type: z.literal("conversation_message"),
    message_id: z.string(),
    role: z.string(),
    message_type: z.string().nullish(),
    content: z.string(),
    parts: z.unknown().nullish(),
    metadata: z.unknown().nullish(),
    timestamp_ms: z.number(),
    sender_agent_id: z.string().nullish(),
    sender_agent_name: z.string().nullish(),
  }),
  // Phase 19: Message inserted at safe point (for interrupt queue management)
  z.object({
    type: z.literal("message_inserted"),
    agent_id: z.string(),
    message_id: z.string(),
    inserted_at: z.number(),
    conversation_id: z.string().nullish(),
    client_request_id: z.string().nullish(),
  }),
])

/**
 * Zod schema for conversation message SSE events.
 * Validates BackendSseMessage shape at the trust boundary.
 */
const backendSseMessageSchema = z.object({
  conversation_id: z.string(),
  message_id: z.string(),
  role: z.string(),
  content: z.string(),
  parts: z.unknown().default([]),
  metadata: z.unknown().nullable().default(null),
  timestamp: z.number(),
  sequence: z.number(),
  sender_agent_id: z.string().optional(),
  sender_agent_name: z.string().optional(),
})

const conversationRuntimeEventSchema = z.object({
  conversationId: z.string(),
  turnId: z.string(),
  sequence: z.number(),
  timestampMs: z.number(),
  event: agentOutputEventSchema,
})

const conversationRuntimeSnapshotSchema = z.object({
  epoch: z.string(),
  conversationId: z.string(),
  status: z.enum(["idle", "streaming", "completed", "error"]),
  turnId: z.string().nullish(),
  lastSequence: z.number(),
  firstSequence: z.number().nullish(),
  events: z.array(conversationRuntimeEventSchema).default([]),
  startedAtMs: z.number().nullish(),
  updatedAtMs: z.number().nullish(),
})

export type ConversationRuntimeEvent = z.infer<typeof conversationRuntimeEventSchema>
export type ConversationRuntimeSnapshot = z.infer<typeof conversationRuntimeSnapshotSchema>
export type ConversationRuntimeStreamEvent =
  | { kind: "snapshot"; snapshot: ConversationRuntimeSnapshot }
  | { kind: "event"; event: ConversationRuntimeEvent }

export type ToolCallLocation = {
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

/** Attribution injected by the API layer: the conversation whose prompt produced the event. */
interface AgentOutputEventContext {
  conversation_id?: string | null
}

export type AgentOutputEvent =
  | ({ type: "text"; delta: string } & AgentOutputEventContext)
  | ({ type: "thinking"; delta: string } & AgentOutputEventContext)
  | ({ type: "tool_call_start" } & ToolCallEventData & AgentOutputEventContext)
  | ({ type: "tool_call_input"; id: string; delta: string } & AgentOutputEventContext)
  | ({ type: "tool_call_complete" } & ToolCallEventData & AgentOutputEventContext)
  | ({ type: "tool_call_error"; id: string; error: string } & AgentOutputEventContext)
  | ({ type: "session_title_update"; title: string } & AgentOutputEventContext)
  | ({ type: "subagent_spawned"; subagent_session_id: string; name: string; task: string; role?: string | null } & AgentOutputEventContext)
  | ({ type: "subagent_state_update"; subagent_session_id: string; state: string; role?: string | null } & AgentOutputEventContext)
  | ({ type: "done"; stop_reason: string } & AgentOutputEventContext)
  | ({ type: "turn_started"; role?: string | null } & AgentOutputEventContext)
  | ({ type: "error"; message: string } & AgentOutputEventContext)
  | ({
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
    } & AgentOutputEventContext)
  // Phase 19: Message inserted at safe point (for interrupt queue management)
  | ({
      type: "message_inserted"
      agent_id: string
      message_id: string
      inserted_at: number
      client_request_id?: string | null
    } & AgentOutputEventContext)

export type UIMessageChunk =
  | { type: "text-start" }
  | { type: "text-delta"; textDelta: string }
  | { type: "text-end" }
  | { type: "thinking-start" }
  | { type: "thinking-delta"; thinkingDelta: string }
  | { type: "thinking-end" }
  | { type: "tool-use"; toolUse: { id: string; name: string; input?: unknown } }
  | { type: "tool-input-delta"; toolInputDelta: { id: string; delta: string } }
  | { type: "tool-result"; toolResult: { id: string; output: unknown } }
  | { type: "finish"; finishReason: string }
  | { type: "error"; errorText: string }

export function convertEventToChunk(event: AgentOutputEvent): UIMessageChunk | null {
  switch (event.type) {
    case "text":
      return { type: "text-delta", textDelta: event.delta }
    case "thinking":
      return { type: "thinking-delta", thinkingDelta: event.delta }
    case "tool_call_start":
      return { type: "tool-use", toolUse: { id: event.id, name: event.name } }
    case "tool_call_input":
      return { type: "tool-input-delta", toolInputDelta: { id: event.id, delta: event.delta } }
    case "tool_call_complete":
      return {
        type: "tool-result",
        toolResult: {
          id: event.id,
          output: event.output ?? { success: true },
        },
      }
    case "tool_call_error":
      return {
        type: "error",
        errorText: `Tool call failed: ${event.error}`,
      }
    case "session_title_update":
      // Session title update is not a message chunk, return null
      return null
    case "done":
      return { type: "finish", finishReason: event.stop_reason }
    case "error":
      return { type: "error", errorText: event.message }
    default:
      log.warn("Unknown event type", undefined, { event })
      return null
  }
}

export function subscribeAgentStream(
  agentId: string,
  promptId: string,
  onChunk: (chunk: UIMessageChunk) => void,
  onError?: (error: Error) => void,
): () => void {
  const { apiUrl, token } = getErgataiAuthConfig()
  const url = `${apiUrl}/api/v1/agents/${encodeURIComponent(agentId)}/stream?prompt_id=${encodeURIComponent(promptId)}`
  const controller = new AbortController()
  let cleanedUp = false

  const cleanup = () => {
    if (cleanedUp) return
    cleanedUp = true
    controller.abort()
  }

  void (async () => {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: "text/event-stream",
          Authorization: `Bearer ${token}`,
        },
        signal: controller.signal,
      })

      if (!response.ok) {
        const detail = await response.text()
        throw new Error(`SSE request failed: ${response.status} ${detail.trim()}`)
      }

      if (!response.body) {
        throw new Error("SSE response has no readable body")
      }

      let inTextBlock = false
      let inThinkingBlock = false
      let buffer = ""
      let eventName = "message"
      let dataLines: string[] = []

      const closeOpenBlocks = () => {
        if (inTextBlock) {
          onChunk({ type: "text-end" })
          inTextBlock = false
        }
        if (inThinkingBlock) {
          onChunk({ type: "thinking-end" })
          inThinkingBlock = false
        }
      }

      const handleEvent = (event: AgentOutputEvent) => {
        if (event.type === "text") {
          if (inThinkingBlock) {
            onChunk({ type: "thinking-end" })
            inThinkingBlock = false
          }
          if (!inTextBlock) {
            onChunk({ type: "text-start" })
            inTextBlock = true
          }
        } else if (event.type === "thinking") {
          if (inTextBlock) {
            onChunk({ type: "text-end" })
            inTextBlock = false
          }
          if (!inThinkingBlock) {
            onChunk({ type: "thinking-start" })
            inThinkingBlock = true
          }
        } else if (event.type === "done" || event.type === "error") {
          closeOpenBlocks()
        }

        const chunk = convertEventToChunk(event)
        if (chunk) onChunk(chunk)

        if (event.type === "done" || event.type === "error") {
          cleanup()
        }
      }

      const dispatchEvent = () => {
        const currentEventName = eventName
        const rawData = dataLines.join("\n")
        eventName = "message"
        dataLines = []

        if (!currentEventName || !rawData) return
        if (![
          "message",
          "text",
          "thinking",
          "tool_call_start",
          "tool_call_input",
          "tool_call_complete",
          "tool_call_error",
          "done",
          "error",
          "session_title_update",
          "subagent_spawned",
          "subagent_state_update",
          "conversation_message",
          "message_inserted",
          "turn_started",
        ].includes(currentEventName)) return

        try {
          const data = JSON.parse(rawData)
          // Validate using Zod schema to ensure type safety
          const event = agentOutputEventSchema.parse(data)
          handleEvent(event)
        } catch (error) {
          log.error("Failed to parse event", error as Error, { currentEventName })
        }
      }

      const handleLine = (line: string) => {
        if (line === "") {
          dispatchEvent()
          return
        }
        if (line.startsWith(":")) return

        const colonIndex = line.indexOf(":")
        if (colonIndex === -1) return

        const field = line.slice(0, colonIndex)
        const value = line.slice(colonIndex + 1)
        const normalizedValue = value.startsWith(" ") ? value.slice(1) : value

        if (field === "event") {
          eventName = normalizedValue
        } else if (field === "data") {
          dataLines.push(normalizedValue)
        }
      }

      const processBuffer = (flush = false) => {
        while (true) {
          const lineEnd = buffer.search(/\r\n|\n|\r/)
          if (lineEnd === -1) break
          if (!flush && lineEnd === buffer.length - 1 && buffer.endsWith("\r")) {
            break
          }

          handleLine(buffer.slice(0, lineEnd))
          buffer = buffer.slice(
            lineEnd + (buffer.startsWith("\r\n", lineEnd) ? 2 : 1),
          )
        }

        if (flush && buffer) {
          buffer = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
          while (true) {
            const lineEnd = buffer.search(/\r\n|\n|\r/)
            if (lineEnd === -1) break
            handleLine(buffer.slice(0, lineEnd))
            buffer = buffer.slice(lineEnd + 1)
          }
          handleLine(buffer)
          buffer = ""
        }
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()

      while (!cleanedUp) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        processBuffer()
      }

      buffer += decoder.decode()
      processBuffer(true)
      closeOpenBlocks()
      cleanup()
    } catch (error) {
      if (controller.signal.aborted) return
      log.error("Connection error", error as Error)
      onError?.(error instanceof Error ? error : new Error("SSE connection failed"))
      cleanup()
    }
  })()

  return cleanup
}

export function subscribeRawAgentStream(
  agentId: string,
  promptId: string | undefined,
  onEvent: (event: AgentOutputEvent) => void,
  onError?: (error: Error) => void,
  onComplete?: () => void,
): () => void {
  const { apiUrl } = getErgataiAuthConfig()
  const streamQuery = new URLSearchParams()
  if (promptId) streamQuery.set("prompt_id", promptId)
  const streamSuffix = streamQuery.toString() ? `?${streamQuery.toString()}` : ""
  const url = `${apiUrl}/api/v1/agents/${encodeURIComponent(agentId)}/stream${streamSuffix}`

  let cleanupRef: (() => void) | null = null

  const parseAndDispatch = (rawEvent: string) => {
    const { eventName, data } = parseSseEventFields(rawEvent)
    if (!data) return

    // Log raw event data for debugging (dev only — may contain sensitive payloads)
    if (process.env.NODE_ENV === "development") {
      log.debug("Raw event received", undefined, { eventName, data })
    }

    let event: AgentOutputEvent
    try {
      event = agentOutputEventSchema.parse(JSON.parse(data))
    } catch (parseError) {
      log.error("Failed to parse or validate event data", parseError as Error)
      return
    }

    if (eventName !== "message" && event.type && eventName !== event.type) {
      if (process.env.NODE_ENV === "development") {
        log.warn("Event type mismatch", undefined, { eventName, eventType: event.type })
      }
    }

    onEvent(event)

    // Auto-cleanup on done/error events
    if ((event.type === "done" || event.type === "error") && cleanupRef) {
      cleanupRef()
    }
  }

  cleanupRef = createSseStream(url, parseAndDispatch, onError, onComplete)
  return cleanupRef
}

/**
 * 将后端 SSE 消息格式 (ConversationMessagePayload) 转换为前端 BackendMessage 格式
 *
 * 后端 SSE 返回的字段：
 * - message_id → 映射到 id
 * - timestamp → 映射到 created_at
 * - parts/metadata → JSON 对象，需要序列化为字符串
 */
function convertSseMessageToBackend(sseMsg: BackendSseMessage): BackendMessage {
  return {
    message_id: sseMsg.message_id,
    conversation_id: sseMsg.conversation_id,
    sequence: sseMsg.sequence,
    role: sseMsg.role,
    parts: typeof sseMsg.parts === "string"
      ? sseMsg.parts
      : JSON.stringify(sseMsg.parts ?? []),
    metadata: sseMsg.metadata === null || sseMsg.metadata === undefined
      ? null
      : typeof sseMsg.metadata === "string"
        ? sseMsg.metadata
        : JSON.stringify(sseMsg.metadata),
    // Agent message fields (may not be present in SSE messages)
    from_agent_id: sseMsg.sender_agent_id ?? null,
    from_agent_name: sseMsg.sender_agent_name ?? null,
    message_type: sseMsg.message_type ?? null,
    content: sseMsg.content ?? null,
    created_at: sseMsg.timestamp,
    updated_at: sseMsg.timestamp,
  }
}

export function subscribeConversationMessages(
  conversationId: string,
  afterSequence: number | undefined,
  onMessage: (message: BackendMessage) => void,
  onError?: (error: Error) => void,
  onComplete?: () => void,
): () => void {
  const { apiUrl } = getErgataiAuthConfig()
  const url = `${apiUrl}/api/v1/conversations/${encodeURIComponent(conversationId)}/sse?after_sequence=${afterSequence ?? 0}`

  const parseAndDispatch = (rawEvent: string) => {
    const { data } = parseSseEventFields(rawEvent)
    if (!data) return

    try {
      // 后端 SSE 返回的是 ConversationMessagePayload 格式
      // zod validates the shape; cast is safe because defaults ensure all required fields exist
      const sseMessage = backendSseMessageSchema.parse(JSON.parse(data)) as BackendSseMessage
      // 转换为前端 BackendMessage 格式
      const message = convertSseMessageToBackend(sseMessage)
      onMessage(message)
    } catch (error) {
      log.error("Failed to parse or validate message", error as Error)
    }
  }

  return createSseStream(url, parseAndDispatch, onError, onComplete)
}

export async function promptAgent(
  agentId: string,
  message: string,
  options?: {
    conversationId?: string
    images?: Array<{
      base64Data: string
      mediaType: string
      filename?: string
    }>
  },
): Promise<{ prompt_id: string }> {
  const { apiUrl, token } = getErgataiAuthConfig()
  const url = `${apiUrl}/api/v1/agents/${encodeURIComponent(agentId)}/prompt`

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      message,
      conversation_id: options?.conversationId,
      images: options?.images?.map((image) => ({
        base64_data: image.base64Data,
        media_type: image.mediaType,
        filename: image.filename,
      })),
      wait_for_stream: true,
    }),
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`Failed to send prompt: ${response.status} ${error}`)
  }

  return response.json()
}

export async function cancelPrompt(agentId: string): Promise<void> {
  const { apiUrl, token } = getErgataiAuthConfig()
  const url = `${apiUrl}/api/v1/agents/${encodeURIComponent(agentId)}/cancel`

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`Failed to cancel prompt: ${response.status} ${error}`)
  }
}

export function subscribeConversationRuntime(
  conversationId: string,
  afterSequence: number | undefined,
  onSnapshot: (snapshot: ConversationRuntimeSnapshot) => void,
  onEvent: (event: ConversationRuntimeEvent) => void,
  onError?: (error: Error) => void,
  onComplete?: () => void,
): () => void {
  const { apiUrl } = getErgataiAuthConfig()
  const query = new URLSearchParams()
  if (afterSequence !== undefined) query.set("after_sequence", String(afterSequence))
  const querySuffix = query.toString() ? `?${query.toString()}` : ""
  const url = `${apiUrl}/api/v1/conversations/${encodeURIComponent(conversationId)}/runtime/stream${querySuffix}`

  const parseAndDispatch = (rawEvent: string) => {
    const { eventName, data } = parseSseEventFields(rawEvent)
    if (!data) return

    try {
      const parsed = JSON.parse(data)
      if (eventName === "snapshot") {
        onSnapshot(conversationRuntimeSnapshotSchema.parse(parsed))
      } else {
        onEvent(conversationRuntimeEventSchema.parse(parsed))
      }
    } catch (error) {
      log.error("Failed to parse SSE event", error as Error)
    }
  }

  return createSseStream(url, parseAndDispatch, onError, onComplete)
}
