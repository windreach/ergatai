import i18n from "@/lib/i18n"
"use client"

import { useMemo } from "react"
import {
  AgentConnectionRow,
  type ProviderConnection,
} from "./agent-connection-row"

/** Connections inherited from a profile with the same runtime command. */
export function useInheritedConnections(
  connections: ProviderConnection[] | undefined,
  agentId: string,
  fallbackAgentId?: string,
) {
  return useMemo(() => {
    if (!fallbackAgentId || fallbackAgentId === agentId) return []
    return (connections ?? []).filter(
      (connection) => connection.agentId === fallbackAgentId,
    )
  }, [connections, fallbackAgentId, agentId])
}

interface InheritedConnectionsProps {
  connections: ProviderConnection[]
  fromDisplayName: string
  onCopyToAgent?: (connection: ProviderConnection) => void
  isCopying?: boolean
}

export function InheritedConnections({
  connections,
  fromDisplayName,
  onCopyToAgent,
  isCopying = false,
}: InheritedConnectionsProps) {
  if (connections.length === 0) return null

  // Backend resolution uses the default connection first, otherwise the first
  // connection in list order. Highlight exactly the one launches will use.
  const activeConnectionId =
    connections.find((connection) => connection.isDefault)?.id ??
    connections[0]?.id

  return (
    <div className="space-y-2">
      <p className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-[11px] leading-4 text-muted-foreground">
        {i18n.t(
          "No provider is configured directly for this agent. It is currently using an inherited connection from {{agent}}; copy it here to edit your own version.",
          { agent: fromDisplayName },
        )}
      </p>
      <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
        {connections.map((connection) => (
          <AgentConnectionRow
            key={connection.id}
            connection={connection}
            readOnly
            inheritedActive={connection.id === activeConnectionId}
            onCopyToAgent={onCopyToAgent}
            isCopying={isCopying}
          />
        ))}
      </div>
    </div>
  )
}
