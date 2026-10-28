import type { UIMessage } from "@ai-sdk/react"
import type { ConversationRuntimeState } from "./conversation-runtime-gateway"

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
    | { type: "error"; message: string }
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
  if (raw.startsWith("Ergatai_MCP_Tools_")) {
    return `mcp__Ergatai_MCP_Tools__${raw.slice("Ergatai_MCP_Tools_".length)}`
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

  const finalizeStreamMessage = () => {
    if (!currentMessage || currentMessage.parts.length === 0) {
      currentMessage = null
      return
    }

    currentMessage.metadata = {
      ...(currentMessage.metadata ?? {}),
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
        runtimeMetadata.projectionKind === "side_copy"
      ) {
        continue
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
          senderAgentId: event.sender_agent_id ?? persistedMetadata.senderAgentId,
          senderAgentName: event.sender_agent_name ?? persistedMetadata.senderAgentName,
          messageType: event.message_type ?? persistedMetadata.messageType,
          // AgentMessageItem prefers this structured content for agent requests.
          agentContent: event.role === "agent" ? structuredContent : undefined,
        },
        parts: shouldUseStructuredContent && structuredContent
          ? [{ type: "text", text: structuredContent }]
          : rawParts.length > 0
            ? rawParts
            : [{ type: "text", text: event.content }],
      } as UIMessage)
      continue
    }

    if (event.type === "done" || event.type === "error") {
      finalizeStreamMessage()
      continue
    }

    switch (event.type) {
      case "text": {
        // Match the transport layer behavior: each text block (separated by
        // thinking or tool calls) creates a new text part.
        const message = ensureStreamMessage(event.role)
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
