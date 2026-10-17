"use client"

import { useEffect, useMemo, useState } from "react"
import { useAtom } from "jotai"
import { Button } from "../ui/button"
import { trpc } from "../../lib/trpc"
import { toast } from "sonner"
import {
  deniedMcpIdentifiersAtom,
  type PendingMcpServerApproval,
  type PendingToolApproval,
} from "../../lib/atoms"

const MCP_POLL_INTERVAL_MS = 30_000
const APPROVED_POLL_INTERVAL_MS = 15_000
const PERMISSION_FALLBACK_POLL_INTERVAL_MS = 5_000

type BackendPendingRequest = {
  requestId: string
  kind: "tool" | "mcp-server"
  source: "acp" | "elicitation" | "launch-gate"
  agentId?: string | null
  title: string
  toolName?: string | null
  input?: unknown
  locations?: string[]
  createdAtMs: number
}

type PermissionRequestEvent = BackendPendingRequest & {
  type: "permission_request"
}

type PermissionResolvedEvent = {
  type: "permission_resolved"
  requestId: string
}

type PermissionStreamEvent = PermissionRequestEvent | PermissionResolvedEvent

function normalizePendingRequests(data: unknown): BackendPendingRequest[] {
  if (!data || typeof data !== "object") return []
  const requests = (data as { requests?: unknown }).requests
  if (!Array.isArray(requests)) return []
  return requests.filter((request): request is BackendPendingRequest =>
    request != null &&
    typeof request === "object" &&
    typeof (request as BackendPendingRequest).requestId === "string" &&
    typeof (request as BackendPendingRequest).kind === "string" &&
    typeof (request as BackendPendingRequest).source === "string" &&
    typeof (request as BackendPendingRequest).title === "string"
  )
}

function applyPermissionStreamEvent(
  data: unknown,
  event: PermissionStreamEvent,
): { requests: BackendPendingRequest[] } {
  const requests = normalizePendingRequests(data)

  if (event.type === "permission_resolved") {
    return {
      requests: requests.filter((request) => request.requestId !== event.requestId),
    }
  }

  const { type: _eventType, ...request } = event
  return {
    requests: [
      request,
      ...requests.filter((item) => item.requestId !== request.requestId),
    ],
  }
}

export function PermissionApprovalPanel({
  chatId,
  conversationId,
  onHasPendingChange,
}: {
  chatId: string
  conversationId: string
  onHasPendingChange?: (hasPending: boolean) => void
}) {
  const [deniedIdentifiers, setDeniedIdentifiers] = useAtom(
    deniedMcpIdentifiersAtom,
  )
  const [dismissedToolIds, setDismissedToolIds] = useState<Set<string>>(
    () => new Set(),
  )
  const [isPermissionStreamConnected, setIsPermissionStreamConnected] =
    useState(false)
  const utils = trpc.useUtils()

  const pluginsQuery = trpc.plugins.list.useQuery(undefined, {
    staleTime: MCP_POLL_INTERVAL_MS,
    refetchInterval: MCP_POLL_INTERVAL_MS,
  })
  const approvedQuery =
    trpc.claudeSettings.getApprovedPluginMcpServers.useQuery(undefined, {
      staleTime: APPROVED_POLL_INTERVAL_MS,
      refetchInterval: APPROVED_POLL_INTERVAL_MS,
    })
  const mcpConfigQuery = trpc.claude.getAllMcpConfig.useQuery(undefined, {
    staleTime: MCP_POLL_INTERVAL_MS,
    refetchInterval: MCP_POLL_INTERVAL_MS,
  })
  const pendingPermissionsQuery = trpc.ergatai.getPendingPermissions.useQuery(
    undefined,
    {
      refetchInterval: PERMISSION_FALLBACK_POLL_INTERVAL_MS,
      staleTime: 0,
    },
  )
  const agentBindingsQuery = trpc.ergatai.getAgentBindings.useQuery(
    { chatId },
    {
      staleTime: 0,  // Always refetch when invalidated to avoid race conditions
      gcTime: 30_000,
    },
  )

  trpc.ergatai.subscribePermissions.useSubscription(undefined, {
    onStarted: () => {
      setIsPermissionStreamConnected(true)
      void utils.ergatai.getPendingPermissions.invalidate()
      void utils.ergatai.getAgentBindings.invalidate({ chatId })
    },
    onData: (event: PermissionStreamEvent) => {
      setIsPermissionStreamConnected(true)
      utils.ergatai.getPendingPermissions.setData(
        undefined,
        (current: unknown) => applyPermissionStreamEvent(current, event),
      )
      if (event.type === "permission_request") {
        void utils.ergatai.getAgentBindings.invalidate({ chatId })
      }
    },
    onError: () => {
      setIsPermissionStreamConnected(false)
      void utils.ergatai.getPendingPermissions.invalidate()
    },
    onComplete: () => {
      setIsPermissionStreamConnected(false)
      void utils.ergatai.getPendingPermissions.invalidate()
    },
  })

  const approveMcpMutation =
    trpc.claudeSettings.approvePluginMcpServer.useMutation()
  const approveAllMcpMutation =
    trpc.claudeSettings.approveAllPluginMcpServers.useMutation()
  const respondToolApprovalMutation =
    trpc.claude.respondToolApproval.useMutation()

  const backendPendingRequests = useMemo<BackendPendingRequest[]>(() => {
    return normalizePendingRequests(pendingPermissionsQuery.data)
  }, [pendingPermissionsQuery.data])

  const backendToolApprovals = useMemo<(PendingToolApproval | PendingMcpServerApproval)[]>(
    () =>
      backendPendingRequests
        .filter((request) => {
          const conversationAgentIds = (agentBindingsQuery.data ?? [])
            .filter((binding) => binding.conversationId === conversationId)
            .map((binding) => binding.agentId)
          return (
            request.agentId != null &&
            conversationAgentIds.includes(request.agentId)
          )
        })
        .filter(
          (request) =>
            (request.kind === "tool" || request.kind === "mcp-server") &&
            request.source !== "elicitation",
        )
        .filter((request) => !dismissedToolIds.has(request.requestId))
        .map((request) => {
          if (request.kind === "mcp-server") {
            // Handle MCP server approval from backend
            // Safely extract config - ensure input is an object before using it
            const inputObj = request.input
            const config = (inputObj != null && typeof inputObj === "object" && !Array.isArray(inputObj))
              ? inputObj as Record<string, unknown>
              : {}
            return {
              kind: "mcp-server" as const,
              pluginSource: (config as { source?: string })?.source ?? "unknown",
              serverName: request.toolName ?? "MCP Server",
              identifier: request.requestId,
              config,
            }
          }
          return {
            kind: "tool-approval" as const,
            toolUseId: request.requestId,
            toolName: request.toolName ?? "Tool",
            title: request.title,
            conversationId: request.agentId ?? undefined,
            input: request.input,
          }
        }),
    [
      agentBindingsQuery.data,
      backendPendingRequests,
      conversationId,
      dismissedToolIds,
    ],
  )

  const pendingMcpApprovals = useMemo<PendingMcpServerApproval[]>(() => {
    const plugins = pluginsQuery.data
    const approved = approvedQuery.data
    if (!plugins || !approved) return []

    const approvedSet = new Set(approved)
    const configByServerName = new Map<string, Record<string, unknown>>()
    for (const group of mcpConfigQuery.data?.groups ?? []) {
      for (const server of group.mcpServers) {
        configByServerName.set(server.name, server.config)
      }
    }

    const pending: PendingMcpServerApproval[] = []
    for (const plugin of plugins) {
      if (plugin.isDisabled) continue
      for (const serverName of plugin.components.mcpServers) {
        const identifier = `${plugin.source}:${serverName}`
        if (approvedSet.has(identifier) || deniedIdentifiers.has(identifier)) {
          continue
        }
        pending.push({
          kind: "mcp-server",
          pluginSource: plugin.source,
          serverName,
          identifier,
          config: configByServerName.get(serverName) ?? {},
        })
      }
    }
    return pending
  }, [
    pluginsQuery.data,
    approvedQuery.data,
    mcpConfigQuery.data,
    deniedIdentifiers,
  ])

  const queue = useMemo(
    () => [...backendToolApprovals, ...pendingMcpApprovals],
    [backendToolApprovals, pendingMcpApprovals],
  )
  const current = queue[0]
  const pendingCount = queue.length - 1

  useEffect(() => {
    onHasPendingChange?.(current != null)
  }, [current, onHasPendingChange])

  const handleMcpAllow = async () => {
    if (!current || current.kind !== "mcp-server") return

    try {
      await approveMcpMutation.mutateAsync({
        identifier: current.identifier,
      })
      toast.success("MCP server approved", {
        description: current.serverName,
      })
      await utils.claudeSettings.getApprovedPluginMcpServers.invalidate()
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to approve"
      toast.error(message)
    }
  }

  const handleMcpAllowAll = async () => {
    if (!current || current.kind !== "mcp-server") return

    const samePlugin = queue.filter(
      (request): request is PendingMcpServerApproval =>
        request.kind === "mcp-server" &&
        request.pluginSource === current.pluginSource,
    )

    try {
      await approveAllMcpMutation.mutateAsync({
        pluginSource: current.pluginSource,
        serverNames: samePlugin.map((request) => request.serverName),
      })
      toast.success("All MCP servers approved", {
        description: `${samePlugin.length} server(s) from ${current.pluginSource}`,
      })
      await utils.claudeSettings.getApprovedPluginMcpServers.invalidate()
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to approve"
      toast.error(message)
    }
  }

  const handleMcpDeny = () => {
    if (!current || current.kind !== "mcp-server") return
    setDeniedIdentifiers(
      (prev) => new Set(prev).add(current.identifier),
    )
  }

  const handleToolDecision = async (approved: boolean) => {
    if (!current || current.kind !== "tool-approval") return

    try {
      await respondToolApprovalMutation.mutateAsync({
        toolUseId: current.toolUseId,
        approved,
      })
      setDismissedToolIds((prev) => new Set(prev).add(current.toolUseId))
      await utils.ergatai.getPendingPermissions.invalidate()
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to respond"
      toast.error(message)
    }
  }

  if (!current) return null

  const isMcpServer = current.kind === "mcp-server"
  const pendingLabel = pendingCount > 0 ? `+${pendingCount} more` : undefined
  const toolPending = respondToolApprovalMutation.isPending

  return (
    <div className="border rounded-t-xl border-b-0 border-border bg-muted/30 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5">
        <div className="flex items-center gap-1.5">
          <span className="text-[12px] text-muted-foreground">
            {isMcpServer ? "MCP" : "Permission"}
          </span>
          <span className="text-muted-foreground/50">•</span>
          <span className="text-[12px] text-muted-foreground">
            {isMcpServer ? current.serverName : current.toolName}
          </span>
        </div>
        {pendingLabel && (
          <span className="text-xs text-muted-foreground">{pendingLabel}</span>
        )}
      </div>

      <div className="px-1 pb-2">
        <div className="px-2 pt-1 pb-3 text-[14px] font-[450] text-foreground">
          {isMcpServer
            ? "Allow this plugin to connect?"
            : current.title ?? "An agent is requesting permission to use a tool"}
        </div>

        {isMcpServer ? (
          <div className="mx-2 rounded-md border border-border/60 bg-background/50 p-2 text-[12px]">
            <div className="flex gap-2">
              <span className="w-14 shrink-0 text-muted-foreground">Plugin</span>
              <span className="text-foreground font-medium">
                {current.pluginSource}
              </span>
            </div>
            <div className="mt-1 flex gap-2">
              <span className="w-14 shrink-0 text-muted-foreground">Server</span>
              <span className="text-foreground font-mono">{current.serverName}</span>
            </div>
            {typeof current.config.command === "string" &&
              current.config.command.length > 0 && (
                <div className="mt-1 flex gap-2">
                  <span className="w-14 shrink-0 text-muted-foreground">
                    Command
                  </span>
                  <span className="break-all font-mono text-foreground">
                    {current.config.command}
                    {Array.isArray(current.config.args) &&
                      current.config.args.length > 0 &&
                      ` ${current.config.args.join(" ")}`}
                  </span>
                </div>
              )}
            {typeof current.config.url === "string" &&
              current.config.url.length > 0 && (
                <div className="mt-1 flex gap-2">
                  <span className="w-14 shrink-0 text-muted-foreground">URL</span>
                  <span className="break-all font-mono text-foreground">
                    {current.config.url}
                  </span>
                </div>
              )}
          </div>
        ) : (
          current.input != null && (
            <pre className="mx-2 max-h-32 overflow-auto rounded-md border border-border/60 bg-background/50 p-2 text-[12px] font-mono whitespace-pre-wrap break-all">
              {typeof current.input === "string"
                ? current.input
                : JSON.stringify(current.input, null, 2)}
            </pre>
          )
        )}
      </div>

      <div className="flex items-center justify-end gap-2 px-2 py-2">
        {isMcpServer ? (
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleMcpDeny}
              disabled={approveMcpMutation.isPending || approveAllMcpMutation.isPending}
              className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground"
            >
              Don't Allow
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleMcpAllowAll}
              disabled={approveMcpMutation.isPending || approveAllMcpMutation.isPending}
              className="h-6 px-2 text-xs"
            >
              Allow All
            </Button>
            <Button
              size="sm"
              onClick={handleMcpAllow}
              disabled={approveMcpMutation.isPending || approveAllMcpMutation.isPending}
              className="h-6 px-3 text-xs"
            >
              Allow
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => handleToolDecision(false)}
              disabled={toolPending}
              className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground"
            >
              Deny
            </Button>
            <Button
              size="sm"
              onClick={() => handleToolDecision(true)}
              disabled={toolPending}
              className="h-6 px-3 text-xs"
            >
              Approve
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
