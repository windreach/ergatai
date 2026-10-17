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
import { useConversationMessages } from "../hooks/use-conversation-messages"

type PersistedMessage = {
  id: string
  sequence: number
  role: string
  parts: unknown[]
  metadata: Record<string, unknown> | null
}

function getMessageText(message: PersistedMessage) {
  return message.parts
    .filter((part): part is { type: "text"; text: string } =>
      (part as any)?.type === "text" && typeof (part as any)?.text === "string",
    )
    .map((part) => part.text)
    .join("\n")
    .trim()
}

type InterAgentTarget = {
  key: string
  requestedAgentId?: string
  runtimeAgentId?: string
}

function getOutputTargetAgentId(part: any) {
  const outputText = (Array.isArray(part.output) ? part.output : [])
    .map((item: any) => typeof item?.text === "string" ? item.text : "")
    .join("\n")

  try {
    const parsed = JSON.parse(outputText) as { target_agent?: unknown }
    return typeof parsed.target_agent === "string" && parsed.target_agent.length > 0
      ? parsed.target_agent
      : undefined
  } catch {
    return undefined
  }
}

function getInterAgentTargets(parts: unknown[]): InterAgentTarget[] {
  return parts.flatMap((part, index) => {
    const candidate = part as {
      type?: unknown
      state?: unknown
      toolCallId?: unknown
      input?: { target_agent_id?: unknown }
      output?: unknown
    }
    const type = typeof candidate.type === "string" ? candidate.type : ""
    if (
      !type.startsWith("tool-mcp__") ||
      !type.endsWith("__send_message") ||
      candidate.state !== "output-available"
    ) {
      return []
    }

    const requestedAgentId = typeof candidate.input?.target_agent_id === "string"
      && candidate.input.target_agent_id.length > 0
      ? candidate.input.target_agent_id
      : undefined
    const runtimeAgentId = getOutputTargetAgentId(candidate)

    if (!requestedAgentId && !runtimeAgentId) return []

    return [{
      key: typeof candidate.toolCallId === "string"
        ? candidate.toolCallId
        : `mcp-${index}`,
      requestedAgentId,
      runtimeAgentId,
    }]
  })
}

function AgentReplyDisclosure({
  conversationId,
  agentId,
  agentName,
}: {
  conversationId: string
  agentId: string
  agentName: string
}) {
  const { messages, isLoading } = useConversationMessages(conversationId)

  const replies = useMemo(() => {
    if (isLoading) return []

    return (messages as PersistedMessage[])
      .filter((message) => {
        const metadata = message.metadata

        return message.role !== "system" &&
          metadata?.source === "agent" &&
          metadata.senderAgentId === agentId
      })
      .sort((left, right) => left.sequence - right.sequence)
      .map((message) => ({
        ...message,
        text: getMessageText(message),
      }))
      .filter((message) => message.text.length > 0)
  }, [messages, agentId, isLoading])

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
  message: any
  chatId: string
}) {
  const isPersistedChat = chatId.startsWith("chat_")
  const { data: bindings } = trpc.ergatai.getAgentBindings.useQuery(
    { chatId },
    { enabled: isPersistedChat },
  )

  const targets = useMemo(
    () => getInterAgentTargets(Array.isArray(message?.parts) ? message.parts : []),
    [message],
  )

  const resolvedTargets = useMemo(() => {
    if (!bindings) return []

    return targets.flatMap((target) => {
      const normalizedRequested = target.requestedAgentId?.toLowerCase()
      const binding = [...bindings]
        .reverse()
        .find((binding) => {
          if (target.runtimeAgentId && binding.agentId === target.runtimeAgentId) {
            return true
          }

          return Boolean(normalizedRequested) && [
            binding.agentName,
            binding.agentCommand,
            binding.agentId,
          ].some((value) => value?.toLowerCase() === normalizedRequested)
        })

      return binding ? [{ key: target.key, binding }] : []
    })
  }, [bindings, targets])

  if (!isPersistedChat || resolvedTargets.length === 0) return null

  return (
    <>
      {resolvedTargets.map(({ key, binding }) => (
        <AgentReplyDisclosure
          key={key}
          conversationId={binding.conversationId}
          agentId={binding.agentId}
          agentName={binding.agentName}
        />
      ))}
    </>
  )
}
