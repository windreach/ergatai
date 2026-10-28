"use client"

import { useState } from "react"
import { useSetAtom } from "jotai"
import { Bot } from "lucide-react"

import { cn } from "../../../lib/utils"
import { sideChatSidebarOpenAtom } from "../../details-sidebar/atoms"
import { groupAgentChatRequestAtomFamily } from "./group-chat-context"
import { getCoreAgentIcon } from "../components/core-agent-selector"
import { resolveCoreAgentId, type CoreAgentId } from "../lib/agent-contract-api"
import type { AgentParticipant } from "./agent-participant"

const STATUS_LABELS: Record<AgentParticipant["status"], string> = {
  pending: "Pending",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  idle: "Idle",
  unknown: "Unknown",
}

const STATUS_BALL_CLASSES: Record<AgentParticipant["status"], string> = {
  pending: "border-border bg-white",
  running: "border-amber-500 bg-amber-500",
  completed: "border-emerald-500 bg-emerald-500",
  failed: "border-red-500 bg-red-500",
  idle: "border-border bg-white",
  unknown: "border-border bg-muted",
}

const MAX_VISIBLE_PARTICIPANTS = 3

function getParticipantIcon(participant: AgentParticipant) {
  if (participant.coreAgentId) return getCoreAgentIcon(participant.coreAgentId)

  return Bot
}

interface AgentRailProps {
  chatId: string
  className?: string
  participants: AgentParticipant[]
  hasCardsBelow?: boolean
}

export function AgentRail({
  chatId,
  className,
  participants,
  hasCardsBelow = false,
}: AgentRailProps) {
  const setIsSideChatSidebarOpen = useSetAtom(sideChatSidebarOpenAtom)
  const setAgentChatRequest = useSetAtom(groupAgentChatRequestAtomFamily(chatId))
  const [isExpanded, setIsExpanded] = useState(false)

  if (participants.length === 0) return null

  const visibleParticipants = isExpanded
    ? participants
    : participants.slice(0, MAX_VISIBLE_PARTICIPANTS)
  const hiddenParticipantCount = participants.length - visibleParticipants.length

  const openAgentChat = (participant: AgentParticipant) => {
    setIsSideChatSidebarOpen(true)
    setAgentChatRequest({
      agentId: participant.coreAgentId ?? resolveCoreAgentId(participant.agentId) ?? (participant.agentId as CoreAgentId),
      conversationId: participant.conversationId,
      requestId: Date.now(),
    })
  }

  return (
    <div className={cn(
      "overflow-hidden border-x border-t bg-input-background",
      hasCardsBelow ? "rounded-t-xl" : "rounded-xl pb-6",
      className
    )}>
        {visibleParticipants.map((participant) => {
          const Icon = getParticipantIcon(participant)

          return (
            <button
              key={participant.key}
              type="button"
              title={`${participant.name} · ${STATUS_LABELS[participant.status]}`}
              onClick={() => openAgentChat(participant)}
              className="mx-auto my-1 flex h-8 w-[calc(100%-16px)] shrink-0 items-center justify-center gap-2 rounded-lg px-3 text-xs transition-colors hover:bg-muted"
            >
              <span className="relative flex h-5 w-5 shrink-0 items-center justify-center rounded-full border bg-background text-muted-foreground">
                <Icon className="h-3 w-3" />
                <span
                  className={cn(
                    "absolute -bottom-px -right-px h-2 w-2 rounded-full border",
                    STATUS_BALL_CLASSES[participant.status],
                    participant.status === "running" && "animate-pulse",
                  )}
                />
              </span>
              <span className="min-w-0 truncate font-medium">{participant.name}</span>
              <span className="shrink-0 text-[11px] text-muted-foreground">
                {STATUS_LABELS[participant.status]}
              </span>
            </button>
          )
        })}

        {participants.length > MAX_VISIBLE_PARTICIPANTS && (
          <button
            type="button"
            onClick={() => setIsExpanded((current) => !current)}
            className="mx-auto mb-2 flex h-7 w-[calc(100%-16px)] items-center justify-center rounded-lg px-3 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {isExpanded
              ? "Show less"
              : `View more${hiddenParticipantCount > 0 ? ` (${hiddenParticipantCount})` : ""}`}
          </button>
        )}
      </div>
    )
}
