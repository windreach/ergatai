import i18n from "@/lib/i18n"
"use client"

import { useAtomValue } from "jotai"
import { cn } from "../../../lib/utils"
import {
  resolveAgentRuntimeId,
  type CoreAgentId,
} from "../lib/agent-contract-api"
import { registeredAgentsAtom } from "../atoms"
import { getCoreAgentIcon } from "../components/core-agent-selector"

interface GroupAgentMessageHeaderProps {
  agentId?: CoreAgentId
  agentName?: string
  className?: string
}

export function GroupAgentMessageHeader({
  agentId,
  agentName,
  className,
}: GroupAgentMessageHeaderProps) {
  const registeredAgents = useAtomValue(registeredAgentsAtom)

  if (!agentName) return null

  const runtimeId =
    resolveAgentRuntimeId(registeredAgents, agentId, agentName) ?? undefined
  const Icon = getCoreAgentIcon(agentId ?? "claude-code", runtimeId)

  return (
    <div className={cn("flex items-center gap-2", className)}>
      <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border bg-background text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
      </span>
      <span className="text-xs font-medium text-foreground">{agentName}</span>
    </div>
  )
}