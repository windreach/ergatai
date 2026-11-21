import {
  type ChatMessage,
} from "./chat-contract-api"
import { attachSideCopyProjectionsToTrace } from "./side-copy-projection"

type PersistedSessionMessage = {
  id: string
  sequence: number
  role: string
  parts: unknown[]
  content?: string | null
  metadata?: Record<string, unknown> | null
  createdAt?: Date | string | number
  turnId?: string | null
  stop_reason?: string | null
  projectionKind?: string | null
  originMessageId?: string | null
}

function normalizeMessageRole(role: string): ChatMessage["role"] {
  if (role === "user" || role === "agent") return role
  return "assistant"
}

function getMessageText(parts: unknown[]) {
  return parts
    .map((part) => {
      if (!part || typeof part !== "object") return ""
      const candidate = part as { type?: unknown; text?: unknown }
      if (candidate.type !== "text") return ""
      return typeof candidate.text === "string" ? candidate.text : ""
    })
    .filter(Boolean)
    .join("\n\n")
}

function getReasoningText(parts: unknown[]) {
  return parts
    .map((part) => {
      if (!part || typeof part !== "object") return ""
      const candidate = part as { type?: unknown; text?: unknown }
      if (candidate.type !== "reasoning" || typeof candidate.text !== "string") return ""
      return candidate.text
    })
    .filter(Boolean)
    .join("\n\n")
}

export function mapSessionMessage(message: PersistedSessionMessage): ChatMessage {
  const metadata = message.metadata ?? undefined
  const structuredContent =
    typeof message.content === "string" && message.content.trim().length > 0
      ? message.content
      : undefined
  const isEnvelopeCandidate =
    message.role === "agent" ||
    typeof (metadata as { messageType?: unknown } | undefined)?.messageType === "string"
  const hasTextOnlyParts =
    message.parts.length > 0 &&
    message.parts.every((part) => {
      const candidate = part as { type?: unknown }
      return candidate?.type === "text"
    })
  const displayParts =
    structuredContent && isEnvelopeCandidate && hasTextOnlyParts
      ? [{ type: "text", text: structuredContent }]
      : message.parts
  const readString = (key: string) => {
    const value = metadata?.[key]
    return typeof value === "string" && value.length > 0 ? value : undefined
  }
  const stopReason =
    message.stop_reason ??
    (typeof metadata?.stopReason === "string" ? metadata.stopReason : undefined)
  const mergedMetadata = stopReason
    ? { ...(metadata ?? {}), stopReason }
    : metadata

  return {
    id: message.id,
    role: normalizeMessageRole(message.role),
    content: structuredContent ?? getMessageText(message.parts),
    reasoning: getReasoningText(message.parts) || undefined,
    senderAgentId: readString("senderAgentId") ?? readString("agentId"),
    senderAgentName: readString("senderAgentName") ?? readString("agentName"),
    messageType: readString("messageType"),
    metadata: mergedMetadata,
    parts: displayParts,
    // Preserve canonical ordering keys. Without them the projection service
    // sorts every persisted message after live/runtime messages, which makes
    // freshly fetched user turns render below the reply that answered them.
    sequence: message.sequence,
    createdAt:
      message.createdAt instanceof Date
        ? message.createdAt
        : message.createdAt !== undefined
          ? new Date(message.createdAt)
          : undefined,
    turnId: message.turnId ?? null,
    stopReason: stopReason ?? null,
  }
}

export { attachSideCopyProjectionsToTrace } from "./side-copy-projection"