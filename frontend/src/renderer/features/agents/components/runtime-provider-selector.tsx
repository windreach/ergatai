import i18n from "@/lib/i18n"
"use client"

import { useMemo } from "react"
import { Check, KeyRound, Loader2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { trpc } from "@/lib/trpc"
import { cn } from "@/lib/utils"
import type { ProviderConnection } from "./agent-connection-row"

const PROTOCOL_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  openai_compatible: "OpenAI-compatible",
  opencode: "OpenCode",
}

interface RuntimeProviderSelectorProps {
  /** Runtime profile whose connections can be copied (e.g. "opencode"). */
  runtimeAgentId: string
  runtimeDisplayName: string
  /** Null means inherit the runtime's current default instead of copying. */
  selectedConnectionId: string | null
  onSelect: (connectionId: string | null) => void
}

function summarizeConnection(connection: ProviderConnection) {
  return [
    PROTOCOL_LABELS[connection.protocol] ?? connection.protocol,
    connection.baseUrl,
    connection.defaultModel,
  ]
    .filter(Boolean)
    .join(" · ")
}

export function RuntimeProviderSelector({
  runtimeAgentId,
  runtimeDisplayName,
  selectedConnectionId,
  onSelect,
}: RuntimeProviderSelectorProps) {
  const connectionsQuery = trpc.ergatai.listProviderConnections.useQuery(
    undefined,
    { staleTime: 10_000 },
  )
  const connections = useMemo(
    () =>
      (connectionsQuery.data ?? []).filter(
        (connection) => connection.agentId === runtimeAgentId,
      ),
    [connectionsQuery.data, runtimeAgentId],
  )

  return (
    <div className="space-y-3">
      <div>
        <p className="text-sm font-medium text-foreground">
          {i18n.t("Initial provider")}
        </p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          {i18n.t(
            "Choose a provider connection to copy into the new agent. The runtime's own configuration is not changed.",
          )}
        </p>
      </div>

      <div className="space-y-2">
        <button
          type="button"
          onClick={() => onSelect(null)}
          aria-pressed={selectedConnectionId === null}
          className={cn(
            "flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors",
            selectedConnectionId === null
              ? "border-primary/40 bg-primary/5"
              : "border-border/60 hover:bg-foreground/[0.04]",
          )}
        >
          <span
            className={cn(
              "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
              selectedConnectionId === null
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border",
            )}
          >
            {selectedConnectionId === null && <Check className="h-3 w-3" />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-foreground">
              {i18n.t("Inherit runtime default")}
            </span>
            <span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground">
              {i18n.t(
                "Follow {{runtime}}'s active provider. Future changes to its default also apply.",
                { runtime: runtimeDisplayName },
              )}
            </span>
          </span>
        </button>

        {connectionsQuery.isLoading ? (
          <div className="flex items-center justify-center py-4">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : connections.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-3 py-2.5 text-[11px] leading-4 text-muted-foreground">
            {i18n.t(
              "No provider connections are configured for {{runtime}} yet. You can add one after creating the agent.",
              { runtime: runtimeDisplayName },
            )}
          </p>
        ) : (
          connections.map((connection) => {
            const isSelected = connection.id === selectedConnectionId
            const summary = summarizeConnection(connection)

            return (
              <button
                key={connection.id}
                type="button"
                onClick={() => onSelect(connection.id)}
                aria-pressed={isSelected}
                className={cn(
                  "flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors",
                  isSelected
                    ? "border-primary/40 bg-primary/5"
                    : "border-border/60 hover:bg-foreground/[0.04]",
                )}
              >
                <span
                  className={cn(
                    "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
                    isSelected
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border",
                  )}
                >
                  {isSelected && <Check className="h-3 w-3" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate text-sm font-medium text-foreground">
                      {connection.name}
                    </span>
                    {connection.isDefault && (
                      <Badge variant="secondary" className="text-[10px]">
                        {i18n.t("Default")}
                      </Badge>
                    )}
                    {connection.apiKeyHint ? (
                      <Badge
                        variant="outline"
                        className="font-mono text-[10px] font-normal"
                      >
                        {connection.apiKeyHint}
                      </Badge>
                    ) : (
                      <KeyRound className="h-3 w-3 text-muted-foreground/60" />
                    )}
                  </span>
                  <span
                    className="mt-0.5 block truncate text-[11px] text-muted-foreground"
                    title={summary}
                  >
                    {summary || i18n.t("No endpoint configured")}
                  </span>
                </span>
              </button>
            )
          })
        )}
      </div>
    </div>
  )
}
