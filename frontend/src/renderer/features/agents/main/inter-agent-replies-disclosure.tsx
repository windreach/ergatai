import i18n from "@/lib/i18n"
"use client"

import { useEffect, useMemo, useRef, useState } from "react"

import { ChatMarkdownRenderer } from "../../../components/chat-markdown-renderer"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../../../components/ui/collapsible"
import { ChevronDown } from "lucide-react"
import { cn } from "../../../lib/utils"
import { trpc, trpcClient } from "../../../lib/trpc"
import {
  useConversationMessages,
  type Message,
} from "../hooks/use-conversation-messages"
import {
  subscribeConversationRuntime,
  type ConversationRuntimeState,
} from "../../details-sidebar"
import {
  getSendMessageArgs,
  isErgataiSendMessagePart,
} from "../lib/ergatai-mcp-detection"

// `Message` is imported from the hook; it is the authoritative shape
// (id, sequence, role, parts, metadata, conversationId, createdAt).
// We alias it locally to keep downstream call sites short.
type PersistedMessage = Message

type ReplyItem = PersistedMessage & { text: string }

function extractSendMessageText(part: unknown): string | null {
  const candidate = part as { input?: unknown } | null
  const input = candidate?.input
  if (input && typeof input === "object") {
    const obj = input as { message?: unknown; code?: unknown }
    if (typeof obj.message === "string" && obj.message.trim().length > 0) {
      return obj.message.trim()
    }
    if (typeof obj.code === "string") {
      const code = obj.code
      const patterns = [
        /message\s*=\s*"([\s\S]*?)"\s*,\s*message_type/,
        /message\s*:\s*"([\s\S]*?)"\s*,\s*message_type/,
        /message\s*=\s*'([\s\S]*?)'\s*,\s*message_type/,
        /message\s*:\s*'([\s\S]*?)'\s*,\s*message_type/,
        /message\s*=\s*"([\s\S]*?)"\s*\)/,
        /message\s*:\s*"([\s\S]*?)"\s*\)/,
      ]
      for (const pattern of patterns) {
        const match = code.match(pattern)
        if (match && match[1].trim().length > 0) {
          return match[1].trim()
        }
      }
    }
  }
  return null
}

function getMessageText(message: PersistedMessage) {
  const structuredContent =
    typeof (message as { content?: unknown }).content === "string" &&
    (((message as { content?: string }).content ?? "").trim().length > 0)
      ? ((message as { content?: string }).content as string).trim()
      : null
  if (structuredContent) return structuredContent

  const allTextParts = (message.parts ?? [])
    .filter((part): part is { type: "text"; text: string } => {
      const p = part as { type?: unknown; text?: unknown } | null
      return p?.type === "text" && typeof p.text === "string"
    })
    .map((part) => part.text)
    .filter((text) => text.trim().length > 0)

  const meaningfulTextParts = allTextParts.filter((text) => text.trim() !== "END")

  if (meaningfulTextParts.length > 0) return meaningfulTextParts.join("\n").trim()

  // When the only textual output is the "END" convention, the actual reply
  // to the other agent (if any) is carried by the send_message tool call.
  const extracted: string[] = []
  for (const part of message.parts ?? []) {
    const candidate = part as { type?: unknown } | null
    if (typeof candidate?.type === "string" && candidate.type.includes("tool")) {
      const value = extractSendMessageText(part)
      if (value) extracted.push(value)
    }
  }
  if (extracted.length > 0) return extracted.join("\n").trim()

  return (message.parts ?? [])
    .filter((part): part is { type: "text"; text: string } => {
      const p = part as { type?: unknown; text?: unknown } | null
      return p?.type === "text" && typeof p.text === "string"
    })
    .map((part) => part.text)
    .join("\n")
    .trim()
}

/**
 * Build the comparable identities for an agent reference.
 *
 * The same agent appears in three forms across persistence/API boundaries:
 * - typed runtime ID: `agent_506420019732_000_0000`
 * - raw Snowflake integer: `2124079514442006528`
 * - configured profile name: `opencode`
 *
 * Normalise typed IDs to their raw Snowflake form (and keep the original
 * lower-cased value) so a message's `fromAgentId`/`fromAgentName` can match a
 * binding's `agentId`/`agentName` regardless of which pair was persisted.
 */
function agentIdentities(value: unknown): Set<string> {
  const identities = new Set<string>()
  if (typeof value === "number" && Number.isFinite(value)) {
    identities.add(String(Math.trunc(value)))
    return identities
  }
  if (typeof value !== "string") return identities

  const raw = value.trim().toLowerCase()
  if (!raw) return identities
  identities.add(raw)

  const typed = /^agent_(\d+)_(\d+)_(\d+)$/.exec(raw)
  if (typed) {
    try {
      const snowflake =
        (BigInt(typed[1]) << 22n) |
        (BigInt(typed[2]) << 12n) |
        BigInt(typed[3])
      identities.add(snowflake.toString())
    } catch {
      // Ignore malformed numeric components; the raw value is still usable.
    }
  }
  return identities
}

function replySenderMatches(
  message: PersistedMessage,
  agentId?: string,
  agentName?: string,
) {
  const expected = new Set<string>()
  for (const identity of agentIdentities(agentId)) expected.add(identity)
  for (const identity of agentIdentities(agentName)) expected.add(identity)
  if (expected.size === 0) return true

  // Prefer the structured columns, but also consult metadata: older rows may
  // only carry the sender there, and metadata keeps the typed agent id even
  // when `from_agent_id` was serialised as a lossy JSON number.
  const metadata = message.metadata as Record<string, unknown> | null
  const storedCandidates = [
    message.fromAgentId,
    message.fromAgentName,
    metadata?.senderAgentId,
    metadata?.senderAgentName,
  ]
  for (const stored of storedCandidates) {
    for (const identity of agentIdentities(stored)) {
      if (expected.has(identity)) return true
    }
  }
  return false
}

type InterAgentTarget = {
  key: string
  requestedAgentId?: string
  requestedConversationId?: string
  runtimeAgentId?: string
  messageId?: string
  correlationId?: string
}

function isSendMessageToolPart(candidate: unknown) {
  // Delegate to the shared, agent-agnostic detector so that differences in
  // MCP server name normalisation across agents do not break recognition.
  return isErgataiSendMessagePart(candidate)
}

/**
 * Collect textual payloads from the many output shapes different agents use:
 * - live AI SDK parts: `[{ type: "text", text }]`
 * - ACP/MCP persisted parts: `{ stdout: "..." }`
 * - provider raw output: `{ content: [...] }` / `{ rawOutput: [...] }`
 * - plain strings
 */
function collectToolOutputText(value: unknown, depth = 0): string {
  if (value == null || depth > 4) return ""
  if (typeof value === "string") return value
  if (Array.isArray(value)) {
    return value
      .map((item) => collectToolOutputText(item, depth + 1))
      .filter((text) => text.length > 0)
      .join("\n")
  }
  if (typeof value !== "object") return ""

  const record = value as Record<string, unknown>
  if (typeof record.text === "string") return record.text
  if (typeof record.stdout === "string") return record.stdout
  if (Array.isArray(record.content)) {
    return collectToolOutputText(record.content, depth + 1)
  }
  if (Array.isArray(record.rawOutput)) {
    return collectToolOutputText(record.rawOutput, depth + 1)
  }
  return ""
}

function readToolOutputFields(value: unknown) {
  const parsed = value as {
    target_agent?: unknown
    message_id?: unknown
    correlation_id?: unknown
  } | null
  return {
    targetAgentId:
      typeof parsed?.target_agent === "string" && parsed.target_agent.length > 0
        ? parsed.target_agent
        : undefined,
    messageId:
      typeof parsed?.message_id === "string" && parsed.message_id.length > 0
        ? parsed.message_id
        : undefined,
    correlationId:
      typeof parsed?.correlation_id === "string" && parsed.correlation_id.length > 0
        ? parsed.correlation_id
        : undefined,
  }
}

function parseToolOutputObject(part: unknown): {
  targetAgentId?: string
  messageId?: string
  correlationId?: string
} {
  const candidate = part as { output?: unknown; result?: unknown } | null
  const rawOutput = candidate?.output ?? candidate?.result

  // Some backends persist the structured response directly.
  if (rawOutput && typeof rawOutput === "object" && !Array.isArray(rawOutput)) {
    const direct = rawOutput as Record<string, unknown>
    if (
      "target_agent" in direct ||
      "message_id" in direct ||
      "correlation_id" in direct
    ) {
      return readToolOutputFields(direct)
    }
  }

  const outputText = collectToolOutputText(rawOutput).trim()
  if (!outputText) return {}

  try {
    return readToolOutputFields(JSON.parse(outputText))
  } catch {
    return {}
  }
}

// Persisted ACP tool parts use "result"/"completed"; live AI SDK parts use
// "output-available". Treat every terminal success state as completed so the
// disclosure also works after a page reload.
const COMPLETED_TOOL_STATES = new Set([
  "output-available",
  "result",
  "completed",
  "done",
  "success",
])

function isCompletedToolPart(candidate: {
  state?: unknown
  output?: unknown
  result?: unknown
}) {
  const state =
    typeof candidate.state === "string"
      ? candidate.state.trim().toLowerCase()
      : ""
  if (COMPLETED_TOOL_STATES.has(state)) return true
  // Imported history may omit the state but still carry the tool output.
  return (
    state.length === 0 &&
    (candidate.output != null || candidate.result != null)
  )
}

function getInterAgentTargets(parts: unknown[]): InterAgentTarget[] {
  return parts.flatMap((part, index) => {
    const candidate = part as {
      type?: unknown
      toolKind?: unknown
      state?: unknown
      toolCallId?: unknown
      input?: unknown
      output?: unknown
      result?: unknown
    }
    if (!isSendMessageToolPart(candidate) || !isCompletedToolPart(candidate)) {
      return []
    }

    // Reuse the shared extractor: agents may put the real arguments under
    // `input`, `args`, `input.code` (code-mode wrappers), or the result
    // metadata (`output.metadata.toolCalls[].input`).
    const input = getSendMessageArgs(candidate)
    const requestedAgentId = input?.target_agent_id
    const requestedConversationId = input?.target_conversation_id
    const output = parseToolOutputObject(candidate)
    const runtimeAgentId = output.targetAgentId

    if (!requestedAgentId && !requestedConversationId && !runtimeAgentId) {
      return []
    }

    return [{
      key: typeof candidate.toolCallId === "string"
        ? candidate.toolCallId
        : `mcp-${index}`,
      requestedAgentId,
      requestedConversationId,
      runtimeAgentId,
      messageId: output.messageId,
      correlationId: output.correlationId,
    }]
  })
}

/**
 * Load the host conversation plus live `conversation_message` events.
 *
 * Both the legacy tool-correlation path and the new turn-linked path read from
 * this single source; the pipeline itself is shared per conversation.
 */
function useHostConversationMessages(hostConversationId: string) {
  const hostPipeline = useConversationMessages(hostConversationId, undefined)
  const baseHostMessages = hostPipeline.messages
  const isLoading = hostPipeline.isLoading
  const error = hostPipeline.error

  // Real-time merge: subscribe to the host conversation runtime so that replies
  // that land after this disclosure mounted are merged in without a refetch.
  const [runtimeMessages, setRuntimeMessages] = useState<PersistedMessage[]>([])
  const seenRuntimeMessageIdsRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    seenRuntimeMessageIdsRef.current = new Set()
    setRuntimeMessages([])
    const targetConversationId = hostConversationId

    const unsubscribe = subscribeConversationRuntime(targetConversationId, (state: ConversationRuntimeState) => {
      const newMessages: PersistedMessage[] = []
      for (const entry of state.events ?? []) {
        const event = entry.event as {
          type?: string
          role?: string | null
          message_type?: string | null
          content?: string
          parts?: unknown
          metadata?: unknown
          timestamp_ms?: number
          sender_agent_id?: string | null
          sender_agent_name?: string | null
          message_id?: string | null
        }
        if (event?.type !== "conversation_message") continue
        const messageId = event.message_id
        if (typeof messageId !== "string" || !messageId) continue
        // Only inter-agent replies are relevant for this disclosure.
        const eventHasExternalId =
          typeof event.metadata === "object" &&
          event.metadata !== null &&
          typeof (event.metadata as Record<string, unknown>).externalMessageId === "string" &&
          ((event.metadata as Record<string, unknown>).externalMessageId as string).length > 0
        const isReply =
          event.role === "respagent" ||
          (event.message_type === "response" && eventHasExternalId)
        if (!isReply) continue
        if (seenRuntimeMessageIdsRef.current.has(messageId)) continue
        seenRuntimeMessageIdsRef.current.add(messageId)
        const parts =
          Array.isArray(event.parts) && (event.parts as unknown[]).length > 0
            ? (event.parts as PersistedMessage["parts"])
            : [{ type: "text", text: event.content ?? "" }]
        newMessages.push({
          id: messageId,
          role: (event.role as PersistedMessage["role"]) ?? "respagent",
          conversationId: targetConversationId,
          sequence: entry.sequence,
          parts,
          metadata: (event.metadata as Record<string, unknown>) ?? undefined,
          createdAt: new Date(event.timestamp_ms ?? Date.now()),
          content: event.content,
          messageType: event.message_type ?? null,
          fromAgentId: event.sender_agent_id ?? undefined,
          fromAgentName: event.sender_agent_name ?? undefined,
        } as PersistedMessage)
      }
      if (newMessages.length > 0) {
        setRuntimeMessages((prev) => [...prev, ...newMessages])
      }
    })

    return () => {
      unsubscribe()
    }
  }, [hostConversationId])

  const hostMessages = useMemo<PersistedMessage[]>(() => {
    const byId = new Map<string, PersistedMessage>()
    for (const m of baseHostMessages) byId.set(m.id, m)
    for (const m of runtimeMessages) {
      if (!byId.has(m.id)) byId.set(m.id, m)
    }
    return [...byId.values()].sort((left, right) => {
      const leftTime = left.createdAt instanceof Date ? left.createdAt.getTime() : 0
      const rightTime = right.createdAt instanceof Date ? right.createdAt.getTime() : 0
      if (leftTime !== rightTime) return leftTime - rightTime
      return (left.sequence ?? 0) - (right.sequence ?? 0)
    })
  }, [baseHostMessages, runtimeMessages])

  if (error) {
    // Surface load errors to the console; the surrounding UI renders an empty
    // disclosure, so we log rather than swallow silently.
    console.warn(
      `[InterAgentRepliesDisclosure] Failed to load host conversation ${hostConversationId}:`,
      error,
    )
  }

  return { hostMessages, isLoading }
}

function getReplyToTurnId(message: PersistedMessage): string | undefined {
  const metadata = message.metadata as Record<string, unknown> | null
  const value = metadata?.replyToTurnId
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function getHostTurnId(message: { metadata?: unknown }): string | undefined {
  const metadata = message.metadata as Record<string, unknown> | null | undefined
  const value = metadata?.turnId
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function ReplyCard({
  agentName,
  replies,
}: {
  agentName: string
  replies: ReplyItem[]
}) {
  if (replies.length === 0) return null

  return (
    <Collapsible className="mt-2 w-fit max-w-full">
      <CollapsibleTrigger className="group flex w-fit max-w-full items-center gap-1 rounded-md bg-muted/60 px-2 py-1 text-left text-xs text-muted-foreground transition-colors hover:bg-muted">
        <span className="min-w-0 truncate font-medium">{agentName}</span>
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 shrink-0 transition-transform duration-200",
            "group-data-[state=open]:rotate-180",
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1 min-w-64 max-w-full space-y-3 rounded-lg border border-border/70 bg-muted/20 px-3 py-3">
          {replies.map((reply) => (
            <div key={reply.id} className="space-y-1">
              <ChatMarkdownRenderer content={reply.text} size="sm" />
            </div>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

function AgentReplyDisclosure({
  conversationId,
  agentId,
  agentName,
  hostConversationId,
  replyToMessageId,
  correlationId,
  excludeReplyToTurnId,
}: {
  conversationId: string
  agentId: string
  agentName: string
  hostConversationId?: string
  replyToMessageId?: string
  correlationId?: string
  /**
   * Replies already rendered through the structured `replyToTurnId` link are
   * excluded here to avoid showing the same reply twice.
   */
  excludeReplyToTurnId?: string
}) {
  // Only the host conversation carries MCP-delivered replies (role
  // "respagent"). The external agent's own conversation is intentionally not
  // used as a fallback: its assistant text can be an un-delivered attempt
  // (e.g. Codex printing a `send_message` call as plain text), which must not
  // be presented as a reply.
  const { hostMessages, isLoading } = useHostConversationMessages(
    hostConversationId ?? conversationId,
  )

  const replies = useMemo<ReplyItem[]>(() => {
    if (isLoading) return []

    const matchesRequestFor = (message: PersistedMessage) => {
      const metadata = message.metadata as
        | { correlationId?: unknown; replyToMessageId?: unknown }
        | null
      const messageCorrelationId =
        typeof metadata?.correlationId === "string" ? metadata.correlationId : undefined
      const messageReplyToMessageId =
        typeof metadata?.replyToMessageId === "string"
          ? metadata.replyToMessageId
          : undefined
      return !replyToMessageId && !correlationId
        ? true
        : messageReplyToMessageId === replyToMessageId ||
          (Boolean(correlationId) && messageCorrelationId === correlationId)
    }

    // Host conversation: MCP-delivered replies only. External agent responses
    // have role="respagent" (set by backend based on sender vs conversation
    // owner comparison).
    return hostMessages
      .filter((message) => {
        const hasExternalId =
          typeof message.metadata?.externalMessageId === "string" &&
          (message.metadata.externalMessageId as string).length > 0
        const isReply =
          message.role === "respagent" ||
          (message.messageType === "response" && hasExternalId)
        return (
          isReply &&
          (!excludeReplyToTurnId ||
            getReplyToTurnId(message) !== excludeReplyToTurnId) &&
          replySenderMatches(message, agentId, agentName) &&
          matchesRequestFor(message) &&
          getMessageText(message).length > 0
        )
      })
      .sort((left, right) => {
        const leftTime =
          left.createdAt instanceof Date ? left.createdAt.getTime() : 0
        const rightTime =
          right.createdAt instanceof Date ? right.createdAt.getTime() : 0
        if (leftTime !== rightTime) return leftTime - rightTime
        return (left.sequence ?? 0) - (right.sequence ?? 0)
      })
      .map((message) => ({ ...message, text: getMessageText(message) }))
      .filter((message) => message.text.length > 0)
  }, [
    correlationId,
    excludeReplyToTurnId,
    hostMessages,
    replyToMessageId,
    isLoading,
    agentName,
    agentId,
  ])

  // A transient empty result (e.g. a history refetch lands before the
  // correlation metadata is attached to the projected reply) must not unmount
  // the whole disclosure — unmounting resets the Collapsible open state and
  // remounting it right after is what users perceive as a flicker.
  const lastNonEmptyRepliesRef = useRef<ReplyItem[]>([])
  useEffect(() => {
    if (replies.length > 0) {
      lastNonEmptyRepliesRef.current = replies
    }
  }, [replies])
  const displayReplies =
    replies.length > 0 ? replies : lastNonEmptyRepliesRef.current

  // Debug logging to file (not console) for inter-agent reply lifecycle.
  // Only enabled when ERGATAI_DEBUG_LOG=1 to avoid excessive I/O in production.
  useEffect(() => {
    if (typeof process !== "undefined" && process.env?.ERGATAI_DEBUG_LOG !== "1") return
    void (trpcClient as any).files?.appendFrontendLog?.mutate?.({
      message: JSON.stringify({
        ts: new Date().toISOString(),
        conversationId,
        agentId,
        agentName,
        replyToMessageId,
        correlationId,
        repliesCount: replies.length,
        displayCount: displayReplies.length,
      }),
    })
  }, [conversationId, agentId, agentName, replyToMessageId, correlationId, replies.length, displayReplies.length])

  if (displayReplies.length === 0) return null

  return <ReplyCard agentName={agentName} replies={displayReplies} />
}

/**
 * Render replies linked by the backend-provided `replyToTurnId`.
 *
 * This is the shape-independent path: the backend records the turn that
 * issued a request and persists it on the response, so the UI does not need
 * to understand agent-specific tool-call wrappers (direct MCP parts,
 * code-mode `execute`, ...).
 */
function TurnLinkedReplies({
  hostConversationId,
  hostTurnId,
  agentBindings,
}: {
  hostConversationId: string
  hostTurnId: string
  agentBindings: Array<{
    agentId: string
    agentName: string
    conversationId: string
  }>
}) {
  const { hostMessages, isLoading } = useHostConversationMessages(hostConversationId)

  const groups = useMemo(() => {
    if (isLoading) return []
    const byAgent = new Map<
      string,
      { agentName: string; replies: ReplyItem[] }
    >()

    for (const message of hostMessages) {
      if (getReplyToTurnId(message) !== hostTurnId) continue
      if (message.role !== "respagent" && message.messageType !== "response") {
        continue
      }
      const text = getMessageText(message)
      if (text.length === 0) continue

      const binding = [...agentBindings]
        .reverse()
        .find((candidate) =>
          replySenderMatches(message, candidate.agentId, candidate.agentName),
        )
      const senderId =
        message.fromAgentId ??
        (message.metadata as Record<string, unknown> | null)?.senderAgentId
      const senderName =
        binding?.agentName ??
        message.fromAgentName ??
        (message.metadata as Record<string, unknown> | null)?.senderAgentName
      const key = String(binding?.conversationId ?? senderId ?? senderName ?? "agent")
      const existing = byAgent.get(key) ?? {
        agentName: String(senderName ?? "Agent"),
        replies: [],
      }
      existing.replies.push({ ...message, text })
      byAgent.set(key, existing)
    }

    return [...byAgent.entries()].map(([key, group]) => ({
      key,
      agentName: group.agentName,
      replies: group.replies.sort(
        (left, right) => (left.sequence ?? 0) - (right.sequence ?? 0),
      ),
    }))
  }, [agentBindings, hostMessages, hostTurnId, isLoading])

  if (groups.length === 0) return null

  return (
    <>
      {groups.map((group) => (
        <ReplyCard
          key={group.key}
          agentName={group.agentName}
          replies={group.replies}
        />
      ))}
    </>
  )
}

export function InterAgentRepliesDisclosure({
  message,
  chatId,
  hostConversationId,
}: {
  message: {
    parts?: unknown[]
    conversationId?: string
    metadata?: unknown
  }
  chatId: string
  /**
   * Conversation that owns the assistant message. AI SDK UI messages do not
   * carry `conversationId`, so the chat surface passes the authoritative value
   * here; fall back to the persisted field when present.
   */
  hostConversationId?: string
}) {
  const isPersistedChat = chatId.startsWith("chat_")
  const { data: bindings } = trpc.ergatai.getAgentBindings.useQuery(
    { chatId },
    { enabled: isPersistedChat },
  )

  const hostConversation = hostConversationId ?? message?.conversationId
  const hostTurnId = getHostTurnId(message)

  const targets = useMemo(
    () => getInterAgentTargets(Array.isArray(message?.parts) ? message.parts : []),
    // Depend on the actual parts array so memo recomputes when its identity
    // changes; the outer `message` reference can be unstable even when parts
    // are unchanged, leading to either stale or redundant recomputation.
     
    [message?.parts],
  )

  const resolvedTargets = useMemo(() => {
    if (!bindings) return []

    return targets.flatMap((target) => {
      const normalizedRequested = target.requestedAgentId?.toLowerCase()
      const binding = [...bindings]
        .reverse()
        .find((b) => {
          if (target.runtimeAgentId && b?.agentId === target.runtimeAgentId) {
            return true
          }

          if (
            target.requestedConversationId &&
            b?.conversationId === target.requestedConversationId
          ) {
            return true
          }

          return Boolean(normalizedRequested) && [
            b?.agentName,
            b?.agentCommand,
            b?.agentId,
          ].some((value) => value?.toLowerCase() === normalizedRequested)
        })

      return binding ? [{ key: target.key, target, binding }] : []
    })
  }, [bindings, targets])

  if (!isPersistedChat || !hostConversation) return null

  return (
    <>
      {hostTurnId && (
        <TurnLinkedReplies
          hostConversationId={hostConversation}
          hostTurnId={hostTurnId}
          agentBindings={bindings ?? []}
        />
      )}
      {resolvedTargets.map(({ key, target, binding }) => (
        <AgentReplyDisclosure
          key={key}
          conversationId={binding.conversationId}
          agentId={binding.agentId}
          agentName={binding.agentName}
          hostConversationId={hostConversation}
          replyToMessageId={target.messageId}
          correlationId={target.correlationId}
          excludeReplyToTurnId={hostTurnId}
        />
      ))}
    </>
  )
}