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

export function buildRuntimeMessages(
  snapshot: ConversationRuntimeState | undefined,
): UIMessage[] {
  // The gateway currently types backend events broadly because they cross an
  // untyped SSE boundary. The renderer only needs the recognized subset.
  const runtimeEvents = (snapshot?.events ?? []) as unknown as RuntimeEvent[]
  if (!runtimeEvents.length) return []

  const messages: UIMessage[] = []
  const parts: RuntimePart[] = []
  let runtimeRole: "assistant" | "agent" = "assistant"

  const flushRuntimeParts = () => {
    if (parts.length === 0) return
    messages.push({
      id: `runtime-${snapshot?.conversationId ?? "conversation"}`,
      role: runtimeRole,
      metadata: {
        runtime: true,
        runtimeStatus: snapshot?.status,
        runtimeSequence: snapshot?.lastSequence,
      },
      parts,
    } as UIMessage)
    parts.length = 0
  }

  for (const runtimeEvent of runtimeEvents) {
    const event = runtimeEvent.event

    if (event.type === "conversation_message") {
      flushRuntimeParts()

      const persistedMetadata = (event.metadata && typeof event.metadata === "object")
        ? event.metadata as Record<string, unknown>
        : {}
      const rawParts = Array.isArray(event.parts) ? event.parts : []
      messages.push({
        id: event.message_id,
        role: normalizeRuntimeMessageRole(event.role),
        metadata: {
          ...persistedMetadata,
          senderAgentId: event.sender_agent_id ?? persistedMetadata.senderAgentId,
          senderAgentName: event.sender_agent_name ?? persistedMetadata.senderAgentName,
          messageType: event.message_type ?? persistedMetadata.messageType,
          // AgentMessageItem prefers this structured content for agent requests.
          agentContent: event.role === "agent" ? event.content : undefined,
        },
        parts: rawParts.length > 0
          ? rawParts
          : [{ type: "text", text: event.content }],
      } as UIMessage)
      continue
    }

    switch (event.type) {
      case "text": {
        // Match the transport layer behavior: each text block (separated by
        // thinking or tool calls) creates a new text part.
        if (event.role === "agent") runtimeRole = "agent"
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
        if (event.role === "agent") runtimeRole = "agent"
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
        parts.push({
          type: `tool-${event.name || "unknown"}`,
          toolCallId: event.id,
          state: "input-streaming",
          input: event.input ?? {},
        })
        break
      }
      case "tool_call_complete": {
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
            type: `tool-${event.name || "unknown"}`,
            toolCallId: event.id,
            state: "output-available",
            input: event.input ?? {},
            output: event.output ?? { success: true },
          })
        }
        break
      }
      case "tool_call_error": {
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

  flushRuntimeParts()
  return messages
}
