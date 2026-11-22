// Modified from 1Code (Apache-2.0) by Ergatai — see MODIFICATIONS.md
import i18n from "@/lib/i18n"
"use client"

import { useQuery } from "@tanstack/react-query"
import { memo, useMemo, useState } from "react"
import { ChevronDown } from "lucide-react"
import { OriginalMCPIcon } from "../../../components/ui/icons"
import { cn } from "../../../lib/utils"
import { trpc } from "../../../lib/trpc"

interface McpWidgetProps {
  chatId: string
  worktreePath: string | null
}

interface McpDiscoveryItem {
  name: string
  status?: string
  tools?: string[]
  error?: string
}

/**
 * MCP widget backed by the Rust backend discovery endpoint.
 *
 * Reads MCP server status/tools from `/api/v1/agents/{agent}/discovery`
 * instead of the frontend-local Claude SDK init message.
 */
export const McpWidget = memo(function McpWidget({ chatId, worktreePath }: McpWidgetProps) {
  const [expandedServers, setExpandedServers] = useState<Set<string>>(new Set())

  const bindingsQuery = trpc.ergatai.getAgentBindings.useQuery(
    { chatId },
    { enabled: !!chatId },
  )
  const backendAgentId = bindingsQuery.data?.[0]?.agentId

  const discoveryQuery = trpc.discovery.getAgentDiscovery.useQuery(
    { agentId: backendAgentId!, cwd: worktreePath ?? undefined },
    { enabled: !!backendAgentId },
  )

  const mcpItems = useMemo<McpDiscoveryItem[]>(() => {
    const raw = discoveryQuery.data?.mcp
    if (!Array.isArray(raw)) return []
    return raw as McpDiscoveryItem[]
  }, [discoveryQuery.data])

  const toolsByServer = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const item of mcpItems) {
      map.set(item.name, Array.isArray(item.tools) ? item.tools : [])
    }
    return map
  }, [mcpItems])

  if (discoveryQuery.isLoading || bindingsQuery.isLoading) {
    return (
      <div className="px-2 py-2">
        <div className="text-xs text-muted-foreground">
          {i18n.t("Loading MCP servers...")}
        </div>
      </div>
    )
  }

  if (mcpItems.length === 0) {
    return (
      <div className="px-2 py-2">
        <div className="text-xs text-muted-foreground">
          {i18n.t("No MCP servers configured")}
        </div>
      </div>
    )
  }

  const toggleServer = (name: string) => {
    setExpandedServers((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  return (
    <div className="px-2 py-1.5 flex flex-col gap-0.5">
      {mcpItems.map((server) => {
        const tools = toolsByServer.get(server.name) || []
        const isExpanded = expandedServers.has(server.name)
        const hasTools = tools.length > 0

        return (
          <div key={server.name}>
            <button
              onClick={() => hasTools && toggleServer(server.name)}
              className={cn(
                "w-full flex items-center gap-1.5 min-h-[28px] rounded px-1.5 py-0.5 -ml-0.5 transition-colors",
                hasTools ? "hover:bg-accent cursor-pointer" : "cursor-default",
              )}
            >
              <OriginalMCPIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <span className="text-xs text-foreground truncate flex-1 text-left">
                {server.name}
              </span>
              {server.status && (
                <span className="text-[10px] text-muted-foreground tabular-nums">
                  {server.status}
                </span>
              )}
              {hasTools && (
                <span className="text-[10px] text-muted-foreground tabular-nums">
                  {tools.length}
                </span>
              )}
              {hasTools && (
                <ChevronDown
                  className={cn(
                    "h-3 w-3 text-muted-foreground/50 shrink-0 transition-transform duration-150",
                    !isExpanded && "-rotate-90",
                  )}
                />
              )}
            </button>

            {server.error && (
              <div className="ml-[18px] text-[10px] text-red-500/80 truncate" title={server.error}>
                {server.error}
              </div>
            )}

            {isExpanded && hasTools && (
              <div className="ml-[18px] py-0.5 flex flex-col gap-px">
                {tools.map((tool) => (
                  <div
                    key={tool}
                    className="group/tool w-full flex items-center gap-1.5 text-left text-xs text-muted-foreground hover:text-foreground py-1 px-1.5 rounded hover:bg-accent transition-colors truncate"
                  >
                    <span className="truncate flex-1">{tool}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
})

