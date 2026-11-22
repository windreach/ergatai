import i18n from "@/lib/i18n"
"use client"

import { useMemo } from "react"
import { KeyRound } from "lucide-react"
import { cn } from "@/lib/utils"
import { AgentAvatar } from "./agent-avatar"
import { AgentConnectionsSection } from "./agent-connections-section"

export interface ManageAgentsProviderTarget {
  /** Backend profile name a connection belongs to. */
  profileName: string
  /** Built-in runtime whose logo should be used when no custom avatar exists. */
  runtimeId?: string
  displayName: string
  avatarUrl?: string | null
  /** Profile whose provider connections are inherited when this one has none. */
  fallbackProfileName?: string
  fallbackDisplayName?: string
}

interface ManageAgentsProviderSectionProps {
  /** Agents that can own provider connections. */
  targets: ManageAgentsProviderTarget[]
  /** Backend profile name selected by the user. */
  selectedAgentName: string | null
  onSelectAgent: (profileName: string) => void
}

export function ManageAgentsProviderSection({
  targets,
  selectedAgentName,
  onSelectAgent,
}: ManageAgentsProviderSectionProps) {
  const activeTarget = useMemo(
    () =>
      targets.find((target) => target.profileName === selectedAgentName) ??
      targets[0],
    [targets, selectedAgentName],
  )

  if (targets.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border px-6 py-12 text-center">
        <KeyRound className="h-6 w-6 text-muted-foreground/60" />
        <p className="text-sm font-medium text-foreground">
          {i18n.t("No agents available yet")}
        </p>
        <p className="max-w-sm text-xs leading-5 text-muted-foreground">
          {i18n.t(
            "Install an agent or add a custom runtime first, then add its API keys and endpoints here.",
          )}
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <p className="text-xs leading-5 text-muted-foreground">
        {i18n.t(
          "Provider connections belong to a single agent. Select an agent, then add or edit its API keys and endpoints.",
        )}
      </p>

      <div className="flex flex-wrap gap-2">
        {targets.map((target) => {
          const isActive = target.profileName === activeTarget?.profileName

          return (
            <button
              key={target.profileName}
              type="button"
              onClick={() => onSelectAgent(target.profileName)}
              aria-pressed={isActive}
              className={cn(
                "flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors duration-75",
                isActive
                  ? "border-transparent bg-foreground/[0.08] text-foreground"
                  : "border-border/60 text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground",
              )}
            >
              <AgentAvatar
                runtimeId={target.runtimeId ?? target.profileName}
                avatarUrl={target.avatarUrl}
                className="h-5 w-5 rounded-full border-0 bg-transparent"
                iconClassName="h-3.5 w-3.5"
              />
              <span className="truncate">{target.displayName}</span>
            </button>
          )
        })}
      </div>

      {activeTarget && (
        <div className="rounded-xl border border-border/60 bg-muted/10 p-4">
          <AgentConnectionsSection
            agentId={activeTarget.profileName}
            agentDisplayName={activeTarget.displayName}
            fallbackAgentId={activeTarget.fallbackProfileName}
            fallbackAgentDisplayName={activeTarget.fallbackDisplayName}
          />
        </div>
      )}
    </div>
  )
}
