"use client"

import { useMemo } from "react"

import { ChatMarkdownRenderer } from "../../../components/chat-markdown-renderer"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../../../components/ui/collapsible"
import { ChevronDown } from "lucide-react"
import { cn } from "../../../lib/utils"
import { trpc } from "../../../lib/trpc"
import {
  useConversationMessages,
  type Message,
} from "../hooks/use-conversation-messages"

// `Message` is imported from the hook; it is the authoritative shape
// (id, sequence, role, parts, metadata, conversationId, createdAt).
// We alias it locally to keep downstream call sites short.
type PersistedMessage = Message

function getMessageText(message: PersistedMessage) {
  return message.parts
    .filter((part): part is { type: "text"; text: string } => {
      const p = part as { type?: unknown; text?: unknown } | null
      return p?.type === "text" && typeof p.text === "string"
    })
    .map((part) => part.text)
    .join("\n")
    .trim()
}

type InterAgentTarget = {
  key: string
  requestedAgentId?: string
  runtimeAgentId?: string
  messageId?: string
  correlationId?: string
}

function isSendMessageToolPart(candidate: {
  type?: unknown
  toolKind?: unknown
  input?: { target_agent_id?: unknown; message?: unknown }
}) {
  if (candidate.toolKind === "inter_agent_send") return true

  // Prefer the structured input contract. Tool names have varied across
  // runtime versions, so the name is only a compatibility fallback.
  if (
    typeof candidate.input?.target_agent_id === "string" &&
    typeof candidate.input.message === "string"
  ) {
    return true
  }

  if (typeof candidate.type !== "string") return false

  // Persisted tool calls can use either the canonical MCP tool name
  // (`tool-mcp__<server>__send_message`) or the agent runtime's legacy
  // adapter name (`tool-Ergatai_MCP_Tools_send_message`).
  if (candidate.type.startsWith("tool-mcp__")) {
    return candidate.type.endsWith("__send_message")
  }
  return /^tool-(?:Ergatai_MCP_Tools_)?send_message$/i.test(candidate.type)
}

function parseToolOutputObject(part: unknown) {
  const candidate = part as { output?: unknown } | null
  const rawOutput = candidate?.output
  const outputText = (Array.isArray(rawOutput) ? rawOutput : [])
    .map((item) => {
      const it = item as { text?: unknown } | null
      return typeof it?.text === "string" ? it.text : ""
    })
    .join("\n")

  try {
    const parsed = JSON.parse(outputText || "{}") as {
      target_agent?: unknown
      message_id?: unknown
      correlation_id?: unknown
    }
    return {
      targetAgentId:
        typeof parsed.target_agent === "string" && parsed.target_agent.length > 0
          ? parsed.target_agent
          : undefined,
      messageId:
        typeof parsed.message_id === "string" && parsed.message_id.length > 0
          ? parsed.message_id
          : undefined,
      correlationId:
        typeof parsed.correlation_id === "string" && parsed.correlation_id.length > 0
          ? parsed.correlation_id
          : undefined,
    }
  } catch {
    return {}
  }
}

function getInterAgentTargets(parts: unknown[]): InterAgentTarget[] {
  return parts.flatMap((part, index) => {
    const candidate = part as {
      type?: unknown
      toolKind?: unknown
      state?: unknown
      toolCallId?: unknown
      input?: { target_agent_id?: unknown; message?: unknown }
      output?: unknown
    }
    const type = typeof candidate.type === "string" ? candidate.type : ""
    if (
      !isSendMessageToolPart(candidate) ||
      candidate.state !== "output-available"
    ) {
      return []
    }

    const requestedAgentId = typeof candidate.input?.target_agent_id === "string"
      && candidate.input.target_agent_id.length > 0
      ? candidate.input.target_agent_id
      : undefined
    const output = parseToolOutputObject(candidate)
    const runtimeAgentId = output.targetAgentId

    if (!requestedAgentId && !runtimeAgentId) return []

    return [{
      key: typeof candidate.toolCallId === "string"
        ? candidate.toolCallId
        : `mcp-${index}`,
      requestedAgentId,
      runtimeAgentId,
      messageId: output.messageId,
      correlationId: output.correlationId,
    }]
  })
}

function AgentReplyDisclosure({
  conversationId,
  agentId,
  agentName,
  replyToMessageId,
  correlationId,
}: {
  conversationId: string
  agentId: string
  agentName: string
  replyToMessageId?: string
  correlationId?: string
}) {
  const { messages, isLoading, error } = useConversationMessages(conversationId)

  if (error) {
    // Surface load errors to the console; the surrounding UI falls back to
    // an empty disclosure, so we log rather than swallow silently.
    // eslint-disable-next-line no-console
    console.warn(
      `[InterAgentRepliesDisclosure] Failed to load conversation ${conversationId}:`,
      error,
    )
  }

  const replies = useMemo(() => {
    if (isLoading) return []

    return (messages as PersistedMessage[])
      .filter((message) => {
        const metadata = message.metadata as
          | {
              senderAgentId?: unknown
              correlationId?: unknown
              replyToMessageId?: unknown
              sideConversationCopy?: unknown
              projectionKind?: unknown
            }
          | null
        const isSideCopy =
          metadata?.sideConversationCopy === true ||
          metadata?.projectionKind === "side_copy" ||
          message.projectionKind === "side_copy"

        // The disclosure shows the outbound reply projection, not the whole
        // agent turn. Reasoning/tool events are queried separately as trace.
        const isLegacyReply =
          message.role === "assistant" &&
          message.messageType === "response" &&
          Boolean(message.parts?.every((part: any) => part?.type === "text"))
        const messageCorrelationId =
          typeof metadata?.correlationId === "string" ? metadata.correlationId : undefined
        const messageReplyToMessageId =
          typeof metadata?.replyToMessageId === "string"
            ? metadata.replyToMessageId
            : undefined

        // When the send_message result has correlation metadata, only show the
        // exact turn produced by that request. Legacy messages without either
        // ID remain visible through the fallback path.
        const matchesRequest =
          !replyToMessageId && !correlationId
            ? true
            : messageReplyToMessageId === replyToMessageId ||
              (Boolean(correlationId) && messageCorrelationId === correlationId)

        // The bound conversation is the authoritative ownership boundary:
        // `role: "agent"` is an inbound inter-agent request, while
        // `role: "assistant"` is the bound agent's own reply/output.
        return message.role === "assistant" &&
          (isSideCopy || isLegacyReply) &&
          matchesRequest &&
          getMessageText(message).length > 0
      })
      .sort((left, right) => left.sequence - right.sequence)
      .map((message) => ({
        ...message,
        text: getMessageText(message),
      }))
      .filter((message) => message.text.length > 0)
  }, [correlationId, messages, replyToMessageId, isLoading])

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

export function InterAgentRepliesDisclosure({
  message,
  chatId,
}: {
  message: { parts?: unknown[] }
  chatId: string
}) {
  const isPersistedChat = chatId.startsWith("chat_")
  const { data: bindings } = trpc.ergatai.getAgentBindings.useQuery(
    { chatId },
    { enabled: isPersistedChat },
  )

  const targets = useMemo(
    () => getInterAgentTargets(Array.isArray(message?.parts) ? message.parts : []),
    // Depend on the actual parts array so memo recomputes when its identity
    // changes; the outer `message` reference can be unstable even when parts
    // are unchanged, leading to either stale or redundant recomputation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

          return Boolean(normalizedRequested) && [
            b?.agentName,
            b?.agentCommand,
            b?.agentId,
          ].some((value) => value?.toLowerCase() === normalizedRequested)
        })

      return binding ? [{ key: target.key, target, binding }] : []
    })
  }, [bindings, targets])

  if (!isPersistedChat || resolvedTargets.length === 0) return null

  return (
    <>
      {resolvedTargets.map(({ key, target, binding }) => (
        <AgentReplyDisclosure
          key={key}
          conversationId={binding.conversationId}
          agentId={binding.agentId}
          agentName={binding.agentName}
          replyToMessageId={target.messageId}
          correlationId={target.correlationId}
        />
      ))}
    </>
  )
}
