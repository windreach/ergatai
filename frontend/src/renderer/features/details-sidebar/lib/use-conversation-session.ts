import { useEffect, useMemo, useRef } from "react"

import { trpc } from "@/lib/trpc"

import {
  type ChatMessage,
} from "./chat-contract-api"
import { useConversationRuntime } from "./conversation-runtime-gateway"
import { buildRuntimeMessages } from "./conversation-runtime-ui"
import { attachSideCopyProjectionsToTrace } from "./side-copy-projection"

type PersistedSessionMessage = {
  id: string
  sequence: number
  role: string
  parts: unknown[]
  content?: string | null
  metadata?: Record<string, unknown> | null
  turnId?: string | null
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

function mapSessionMessage(message: PersistedSessionMessage): ChatMessage {
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

  return {
    id: message.id,
    role: normalizeMessageRole(message.role),
    content: structuredContent ?? getMessageText(message.parts),
    reasoning: getReasoningText(message.parts) || undefined,
    senderAgentId: readString("senderAgentId") ?? readString("agentId"),
    senderAgentName: readString("senderAgentName") ?? readString("agentName"),
    messageType: readString("messageType"),
    metadata,
    parts: displayParts,
  }
}

export interface ConversationSessionOptions {
  chatId: string
  conversationId?: string | null
  isActive?: boolean
  /** Messages from a parent snapshot, used while the scoped query is loading. */
  fallbackMessages?: ChatMessage[]
}

/**
 * Shared persisted-message + live-runtime controller for a single backend
 * conversation. Main chat can keep its parent snapshot controller; side chat
 * uses this to avoid depending on the full chat snapshot before render.
 */
export function useConversationSession({
  chatId,
  conversationId,
  isActive = true,
  fallbackMessages = [],
}: ConversationSessionOptions) {
  const messagesQuery = trpc.ergatai.listConversationMessages.useQuery(
    { conversationId: conversationId ?? "" },
    { enabled: isActive && !!conversationId },
  )
  const runtime = useConversationRuntime(conversationId ?? undefined, isActive)
  const trpcUtils = trpc.useUtils()
  const reconciledRuntimeTurnsRef = useRef<Set<string>>(new Set())

  // Durable query + runtime conversation-message events form the same ordered
  // log. Runtime deltas are converted by buildRuntimeMessages; durable agent
  // requests arrive through ConversationMessage runtime events.
  const allPersistedMessages = useMemo(
    () => messagesQuery.data ?? [],
    [messagesQuery.data],
  )

  const persistedMessages = useMemo(
    () => attachSideCopyProjectionsToTrace(allPersistedMessages).map(mapSessionMessage),
    [allPersistedMessages],
  )

  // Prefer fresh scoped persisted messages, but allow the caller's parent
  // snapshot to bridge the first render while the scoped query is loading.
  const messages =
    persistedMessages.length > 0
      ? persistedMessages
      : fallbackMessages

  const isLoadingMessages =
    !!conversationId &&
    persistedMessages.length === 0 &&
    messagesQuery.isLoading

  const runtimeMessages = useMemo(
    () => buildRuntimeMessages(runtime),
    [runtime],
  )
  const runtimeConversationMessages = useMemo(
    () => runtimeMessages.filter((message) => !(message.metadata as any)?.runtime),
    [runtimeMessages],
  )

  // When a runtime turn finishes, reconcile with persisted messages. Runtime
  // output is authoritative while streaming, but persistence owns history.
  useEffect(() => {
    const terminal = runtime?.status === "completed" || runtime?.status === "error"
    if (!terminal || !conversationId) return

    const reconcileKey = [
      conversationId,
      runtime?.turnId ?? "",
      runtime?.lastSequence ?? 0,
      runtime?.status ?? "",
    ].join(":")
    if (reconciledRuntimeTurnsRef.current.has(reconcileKey)) return
    reconciledRuntimeTurnsRef.current.add(reconcileKey)

    void Promise.all([
      messagesQuery.refetch(),
      trpcUtils.chats.get.invalidate({ id: chatId }),
    ])
  }, [
    chatId,
    conversationId,
    messagesQuery.refetch,
    runtime?.lastSequence,
    runtime?.status,
    runtime?.turnId,
    trpcUtils,
  ])

  return {
    messages,
    persistedMessages,
    isLoadingMessages,
    runtime,
    runtimeMessages,
    runtimeConversationMessages,
    refetchPersistedMessages: messagesQuery.refetch,
  }
}
