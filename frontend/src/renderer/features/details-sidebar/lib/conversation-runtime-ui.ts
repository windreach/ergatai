import type { UIMessage } from "@ai-sdk/react"
import type { ConversationRuntimeState } from "./conversation-runtime-gateway"
import { PROJECTION_KINDS } from "@/lib/projection-kinds"

type RuntimeEvent = {
  sequence: number
  event:
    | { type: "text"; delta: string; role?: string }
    | { type: "thinking"; delta: string; role?: string }
    | {
        type: "tool_call_start"
        id: string
        name: string
        input?: unknown
      }
    | { type: "tool_call_input"; id: string; delta: string }
    | {
        type: "tool_call_complete"
        id: string
        name: string
        input?: unknown
        output?: unknown
      }
    | { type: "tool_call_error"; id: string; error: string }
    | { type: "done"; stop_reason: string }
    | {
        type: "error"
        message: string
        role?: string | null
        error_name?: string | null
        error_type?: string | null
        service?: string | null
        code?: number | string | null
        error_data?: unknown
      }
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
}

export type ConversationRuntimeSnapshot = {
  conversationId?: string
  status?: "idle" | "streaming" | "completed" | "error"
  lastSequence?: number
  events?: RuntimeEvent[]
}

type RuntimeUIMessageRole = "user" | "assistant" | "agent"

type RuntimePart = {
  type: string
  toolCallId?: string
  state?: string
  input?: unknown
  output?: unknown
  errorText?: string
  text?: string
  reasoning?: string
}

function normalizeRuntimeMessageRole(role: string): RuntimeUIMessageRole {
  if (role === "user" || role === "agent") return role
  return "assistant"
}

function unwrapAgentEnvelopeText(value: string | null | undefined): string | undefined {
  if (!value) return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    if (
      parsed &&
      typeof parsed === "object" &&
      "message" in parsed &&
      typeof (parsed as { message?: unknown }).message === "string"
    ) {
      return (parsed as { message: string }).message
    }
  } catch {
    // Plain text
  }
  return undefined
}

function normalizeRuntimeToolName(name: string | undefined): string {
  const raw = name?.trim() || "unknown"
  if (raw.startsWith("mcp__")) return raw

  // Normalise legacy Ergatai MCP adapter names regardless of how the agent
  // rendered the server name (spaces, casing, separators). We only special-case
  // the known Ergatai tool names; everything else passes through unchanged.
  const normalized = raw.replace(/[\s-]+/g, "_")
  const ERGATAI_MCP_PREFIX = "Ergatai_MCP_Tools_"
  if (normalized.toLowerCase().startsWith("ergatai_mcp_tools_")) {
    const tool = normalized.slice(ERGATAI_MCP_PREFIX.length)
    return `mcp__Ergatai_MCP_Tools__${tool}`
  }
  // A bare Ergatai server name followed by a tool (e.g. "ergatai send_message")
  if (/^Ergatai[_\s-]+/i.test(raw) && /send_message/i.test(raw)) {
    return "mcp__Ergatai_MCP_Tools__send_message"
  }
  return raw
}

type RuntimeStreamMessage = UIMessage & { parts: RuntimePart[] }

export function buildRuntimeMessages(
  snapshot: ConversationRuntimeState | undefined,
): UIMessage[] {
  // The gateway currently types backend events broadly because they cross an
  // untyped SSE boundary. The renderer only needs the recognized subset.
  const runtimeEvents = (snapshot?.events ?? []) as unknown as RuntimeEvent[]
  if (!runtimeEvents.length) return []

  const messages: UIMessage[] = []
  let currentMessage: RuntimeStreamMessage | null = null
  let currentRole: RuntimeUIMessageRole = "assistant"
  let streamMessageIndex = 0
  const conversationId = snapshot?.conversationId ?? "conversation"
  const turnId = (snapshot as { turnId?: string } | undefined)?.turnId
  let sawExplicitErrorEvent = false

  const finalizeStreamMessage = () => {
    if (!currentMessage || currentMessage.parts.length === 0) {
      currentMessage = null
      return
    }

    currentMessage.metadata = {
      ...(currentMessage.metadata ?? {}),
      turnId,
      runtime: true,
      runtimeStatus: snapshot?.status,
      runtimeSequence: snapshot?.lastSequence,
    }
    currentMessage = null
  }

  const ensureStreamMessage = (role?: string): RuntimeStreamMessage => {
    const nextRole = normalizeRuntimeMessageRole(role ?? currentRole)

    if (currentMessage && currentMessage.role !== nextRole) {
      finalizeStreamMessage()
    }

    if (!currentMessage) {
      currentRole = nextRole
      currentMessage = {
        id: `runtime-${conversationId}-${turnId ?? "turn"}-${streamMessageIndex}`,
        role: nextRole,
        metadata: {
          turnId,
          runtime: true,
          runtimeStatus: snapshot?.status,
          runtimeSequence: snapshot?.lastSequence,
        },
        parts: [],
      } as RuntimeStreamMessage
      messages.push(currentMessage)
      streamMessageIndex += 1
    }

    return currentMessage
  }

  /**
   * Close any currently streaming reasoning part in the active message.
   * Unlike the main chat transport (which emits reasoning-end blocks), the
   * side-channel runtime builds parts directly from events. Without this
   * helper, a reasoning part stays in "input-streaming" state forever after
   * thinking stops but before text/tool events arrive, causing the UI to
   * keep showing "Thinking..." with a ticking counter.
   */
  const closeStreamingReasoning = (message: RuntimeStreamMessage) => {
    const parts = message.parts as RuntimePart[]
    const lastPart = parts.length > 0 ? parts[parts.length - 1] : null
    if (lastPart && lastPart.type === "reasoning" && lastPart.state === "input-streaming") {
      lastPart.state = "output-available"
      lastPart.output = { completed: true }
    }
  }

  for (const runtimeEvent of runtimeEvents) {
    const event = runtimeEvent.event

    if (event.type === "conversation_message") {
      const runtimeMetadata = (event.metadata && typeof event.metadata === "object")
        ? event.metadata as Record<string, unknown>
        : {}

      // Legacy events may still carry side-copy projections into the live
      // stream. They belong to the durable side transcript and must not split
      // the sender's active turn timeline.
      if (
        runtimeMetadata.sideConversationCopy === true ||
        runtimeMetadata.projectionKind === PROJECTION_KINDS.SIDE_COPY
      ) {
        continue
      }

      // Persisted conversation message breaks the current streaming message.
      // Close reasoning first so it doesn't stay in "input-streaming" state.
      if (currentMessage) {
        closeStreamingReasoning(currentMessage)
      }
      finalizeStreamMessage()

      const persistedMetadata = runtimeMetadata
      const rawParts = Array.isArray(event.parts) ? event.parts : []
      const structuredContent = unwrapAgentEnvelopeText(event.content) ??
        (event.content?.trim() ? event.content : undefined)
      const shouldUseStructuredContent =
        Boolean(structuredContent) &&
        (event.role === "agent" || Boolean(event.message_type)) &&
        rawParts.every((part) => {
          const candidate = part as { type?: unknown }
          return candidate?.type === "text"
        })
      messages.push({
        id: event.message_id,
        role: normalizeRuntimeMessageRole(event.role),
        metadata: {
          ...persistedMetadata,
          // Ensure turnId is always present so the projection service can
          // deduplicate across sources (persisted / runtime / local transport).
          // Prefer the event's own turn_id (from backend message metadata);
          // fall back to the snapshot's turnId which covers the current turn.
          turnId: (typeof persistedMetadata.turnId === "string" && persistedMetadata.turnId)
            ? persistedMetadata.turnId
            : (typeof persistedMetadata.turn_id === "string" && persistedMetadata.turn_id)
              ? persistedMetadata.turn_id
              : turnId ?? persistedMetadata.turnId,
          // 统一设置 agentContent：与 mapMessage (use-chat-instance.ts) 保持一致
          // 所有消息都设置 agentContent，不仅仅限于 agent role
          agentContent: structuredContent ?? event.content,
          senderAgentId: event.sender_agent_id ?? persistedMetadata.senderAgentId,
          senderAgentName: event.sender_agent_name ?? persistedMetadata.senderAgentName,
          messageType: event.message_type ?? persistedMetadata.messageType,
        },
        parts: shouldUseStructuredContent && structuredContent
          ? [{ type: "text", text: structuredContent }]
          : rawParts.length > 0
            ? rawParts
            : [{ type: "text", text: event.content }],
      } as UIMessage)
      continue
    }

    if (event.type === "error") {
      sawExplicitErrorEvent = true
      // Close reasoning part before finalizing (stream ended while thinking)
      if (currentMessage) {
        closeStreamingReasoning(currentMessage)
      }

      const parts: string[] = []
      if (event.code != null && event.code !== "") parts.push(`[${event.code}]`)
      const typeName = event.error_type ?? event.error_name
      if (typeName) parts.push(String(typeName))
      if (event.service) parts.push(`(${event.service})`)
      const prefix = parts.join(" ")
      const errorText = prefix ? `${prefix}: ${event.message}` : event.message

      const message = ensureStreamMessage(event.role ?? undefined)
      closeStreamingReasoning(message)
      const msgParts = message.parts
      const lastPart = msgParts.length > 0 ? msgParts[msgParts.length - 1] : null
      if (lastPart && lastPart.type === "text") {
        const prev = lastPart.text ?? ""
        lastPart.text = prev ? `${prev}\n\n${errorText}` : errorText
      } else {
        msgParts.push({ type: "text", text: errorText })
      }

      finalizeStreamMessage()
      continue
    }

    if (event.type === "done") {
      // Close reasoning part before finalizing (stream ended while thinking)
      if (currentMessage) {
        closeStreamingReasoning(currentMessage)
      }

      // Safety net: if backend ends turn with an error stop_reason but the
      // runtime snapshot/events no longer include the explicit error event,
      // keep a visible failure message instead of silently disappearing.
      if (event.stop_reason === "error" && !sawExplicitErrorEvent) {
        const hasRenderedError = messages.some((m) =>
          (m as RuntimeStreamMessage).parts?.some(
            (p) =>
              p.type === "text" &&
              typeof p.text === "string" &&
              (p.text.includes("provider.free-limit") ||
                p.text.includes("Free usage limit") ||
                p.text.toLowerCase().includes("error")),
          ),
        )
        if (!hasRenderedError) {
          const message = ensureStreamMessage()
          closeStreamingReasoning(message)
          message.parts.push({
            type: "text",
            text: "Request failed (stop_reason=error). Please check provider/model limits and retry.",
          })
        }
      }

      finalizeStreamMessage()
      continue
    }

    switch (event.type) {
      case "text": {
        // Match the transport layer behavior: each text block (separated by
        // thinking or tool calls) creates a new text part.
        const message = ensureStreamMessage(event.role)
        // Close reasoning before starting text (thinking → text transition)
        closeStreamingReasoning(message)
        const parts = message.parts
        const lastPart = parts.length > 0 ? parts[parts.length - 1] : null
        let part: RuntimePart
        if (lastPart && lastPart.type === "text") {
          part = lastPart
        } else {
          part = { type: "text", text: "" }
          parts.push(part)
        }
        part.text = (part.text ?? "") + event.delta
        break
      }
      case "thinking": {
        // Match the transport layer behavior: each thinking block (separated by
        // text or tool calls) creates a new reasoning part.
        const message = ensureStreamMessage(event.role)
        const parts = message.parts
        const lastPart = parts.length > 0 ? parts[parts.length - 1] : null
        let part: RuntimePart
        if (lastPart && lastPart.type === "reasoning") {
          part = lastPart
        } else {
          part = {
            type: "reasoning",
            state: "input-streaming",
            input: { text: "" },
          }
          parts.push(part)
        }
        const input = (part.input ??= { text: "" }) as { text?: string }
        input.text = (input.text ?? "") + event.delta
        break
      }
      case "tool_call_start": {
        const message = ensureStreamMessage()
        // Close reasoning before starting a tool call (thinking → tool_call transition)
        closeStreamingReasoning(message)
        message.parts.push({
          type: `tool-${normalizeRuntimeToolName(event.name)}`,
          toolCallId: event.id,
          state: "input-streaming",
          input: event.input ?? {},
        })
        break
      }
      case "tool_call_complete": {
        const message = ensureStreamMessage()
        const parts = message.parts as RuntimePart[]
        const part = parts.find(
          candidate =>
            candidate.toolCallId === event.id &&
            candidate.type.startsWith("tool-"),
        )
        if (part) {
          part.state = "output-available"
          if (event.input !== undefined) part.input = event.input
          part.output = event.output ?? { success: true }
        } else {
          parts.push({
            type: `tool-${normalizeRuntimeToolName(event.name)}`,
            toolCallId: event.id,
            state: "output-available",
            input: event.input ?? {},
            output: event.output ?? { success: true },
          })
        }
        break
      }
      case "tool_call_error": {
        const message = ensureStreamMessage()
        const parts = message.parts as RuntimePart[]
        const part = parts.find(
          candidate =>
            candidate.toolCallId === event.id &&
            candidate.type.startsWith("tool-"),
        )
        if (part) {
          part.state = "output-error"
          part.errorText = event.error
        }
        break
      }
      default:
        break
    }
  }

  finalizeStreamMessage()
  return messages
}
