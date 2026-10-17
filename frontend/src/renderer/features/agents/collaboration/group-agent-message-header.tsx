"use client"

import { cn } from "../../../lib/utils"
import type { CoreAgentId } from "../lib/agent-contract-api"
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
  if (!agentName) return null

  const Icon = getCoreAgentIcon(agentId ?? "claude-code")

  return (
    <div className={cn("flex items-center gap-2", className)}>
      <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border bg-background text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
      </span>
      <span className="text-xs font-medium text-foreground">{agentName}</span>
    </div>
  )
}
