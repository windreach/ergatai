"use client"

import { useMemo, useState } from "react"
import { trpc } from "../../../lib/trpc"
import { Button } from "../../../components/ui/button"
import { Input } from "../../../components/ui/input"
import { Label } from "../../../components/ui/label"
import { Badge } from "../../../components/ui/badge"
// Protocol is now derived automatically from the owning agent.
import { IconSpinner } from "../../../icons"
import { toast } from "sonner"
import { Plus, RotateCcw, Trash2 } from "lucide-react"

type ProviderProtocol = "anthropic" | "openai_compatible" | "opencode"

type ProviderConnection = {
  id: string
  name: string
  /** Owning agent profile name. A connection belongs to exactly one agent. */
  agentId: string
  protocol: ProviderProtocol
  baseUrl?: string | null
  authRef?: string | null
  defaultModel?: string | null
  isDefault: boolean
  createdAt: number
  updatedAt: number
}

const PROTOCOL_OPTIONS: Array<{ value: ProviderProtocol; label: string }> = [
  { value: "anthropic", label: "Anthropic" },
  { value: "openai_compatible", label: "OpenAI-compatible" },
  { value: "opencode", label: "OpenCode" },
]

const EMPTY_FORM = {
  id: "",
  name: "",
  protocol: "anthropic" as ProviderProtocol,
  base_url: "",
  default_model: "",
  api_key: "",
  is_default: false,
}

interface AgentConnectionsSectionProps {
  /** Owning agent profile name (e.g. "claude-code"). */
  agentId: string
  /** Display name used in copy (e.g. "Claude Code"). */
  agentDisplayName: string
}

/**
 * Connections owned by a single registered agent.
 *
 * Product model: one connection belongs to exactly one agent, while one agent
 * may own many connections (multiple keys/endpoints to switch between).
 */
// react-doctor-disable-next-line no-high-complexity-react-function
// react-doctor-disable-next-line no-giant-component
export function AgentConnectionsSection({
  agentId,
  agentDisplayName,
}: AgentConnectionsSectionProps) {
  const utils = trpc.useUtils()
  const connectionsQuery = trpc.ergatai.listProviderConnections.useQuery(
    undefined,
    { staleTime: 10_000 },
  )
  const connections = useMemo(
    () => (connectionsQuery.data ?? []).filter((c) => c.agentId === agentId),
    [connectionsQuery.data, agentId],
  )
  // The agent's own default configuration (settings.json / config.toml),
  // offered as the initial connection when the agent has none yet.
  const nativeQuery = trpc.ergatai.detectNativeConnection.useQuery(
    { agentId },
    {
      staleTime: 30_000,
      retry: false,
      // Never surface this detection failure as a global error boundary;
      // render an inline hint instead so backend version mismatches are visible.
      throwOnError: false,
    },
  )

  const [form, setForm] = useState({ ...EMPTY_FORM })
  const [editingId, setEditingId] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)

  const saveMutation = trpc.ergatai.saveProviderConnection.useMutation({
    onSuccess: () => {
      toast.success("Provider saved")
      void utils.ergatai.listProviderConnections.invalidate()
      resetForm()
    },
    onError: (error) => {
      toast.error(`Failed to save provider: ${error.message}`)
    },
  })

  const setDefaultMutation =
    trpc.ergatai.setDefaultProviderConnection.useMutation({
      onSuccess: () => {
        toast.success("Default provider updated")
        void utils.ergatai.listProviderConnections.invalidate()
      },
      onError: (error) => {
        toast.error(`Failed to set default: ${error.message}`)
      },
    })

  const deleteMutation = trpc.ergatai.deleteProviderConnection.useMutation({
    onSuccess: (data) => {
      if (data.deleted) toast.success("Provider deleted")
      void utils.ergatai.listProviderConnections.invalidate()
      if (editingId) resetForm()
    },
    onError: (error) => {
      toast.error(`Failed to delete provider: ${error.message}`)
    },
  })

  const importMutation = trpc.ergatai.importNativeConnection.useMutation({
    onSuccess: (data) => {
      toast.success(`Provider "${data.connection.name}" imported from ${agentDisplayName} config`)
      void utils.ergatai.listProviderConnections.invalidate()
    },
    onError: (error) => {
      toast.error(`Failed to import configuration: ${error.message}`)
    },
  })

  function resetForm() {
    setForm({ ...EMPTY_FORM })
    setEditingId(null)
    setShowForm(false)
  }

  function protocolForAgent(id: string): ProviderProtocol {
    if (id === "claude-code") return "anthropic"
    if (id === "codex") return "openai_compatible"
    if (id === "opencode") return "opencode"
    return "openai_compatible"
  }

  function startCreate() {
    setForm({ ...EMPTY_FORM, protocol: protocolForAgent(agentId) })
    setEditingId(null)
    setShowForm(true)
  }

  function startEdit(connection: ProviderConnection) {
    setForm({
      id: connection.id,
      name: connection.name,
      protocol: connection.protocol,
      base_url: connection.baseUrl ?? "",
      default_model: connection.defaultModel ?? "",
      api_key: "",
      is_default: connection.isDefault,
    })
    setEditingId(connection.id)
    setShowForm(true)
  }

  function save() {
    if (!form.name.trim()) {
      toast.error("Connection name is required")
      return
    }
    saveMutation.mutate({
      id: form.id || undefined,
      // Connections are owned by this agent only — other agents never see it.
      agent_id: agentId,
      name: form.name.trim(),
      protocol: form.protocol,
      base_url: form.base_url.trim() || undefined,
      default_model: form.default_model.trim() || undefined,
      is_default: form.is_default,
      api_key: form.api_key.trim() || undefined,
    })
  }

  const isLoading = connectionsQuery.isLoading
  const isSaving = saveMutation.isPending

  return (
    // `min-w-0` is required: this section is rendered as a grid item inside
    // DialogContent. Without it the nowrap provider summary (truncate) raises
    // the grid item's automatic minimum width, so the whole list overflows the
    // fixed-width dialog instead of ellipsizing.
    <div className="min-w-0 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-foreground">Providers</p>
        {!showForm && (
          <Button type="button" size="sm" variant="outline" onClick={startCreate}>
            <Plus className="mr-1 h-3.5 w-3.5" />
            Add
          </Button>
        )}
      </div>

      {showForm ? (
        <div className="space-y-3 rounded-lg border border-border bg-background p-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2 space-y-1.5">
              <Label htmlFor="agent-connection-name">Name</Label>
              <Input
                id="agent-connection-name"
                value={form.name}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    name: event.target.value,
                  }))
                }
                placeholder="Production key"
                autoComplete="off"
              />
            </div>
            {/* Protocol is derived automatically from the owning agent and is not user-editable. */}
            <div className="col-span-2 space-y-1.5">
              <Label htmlFor="agent-connection-key">API key</Label>
              <Input
                id="agent-connection-key"
                type="password"
                value={form.api_key}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    api_key: event.target.value,
                  }))
                }
                placeholder={
                  editingId ? "Leave empty to keep current key" : "sk-..."
                }
                autoComplete="off"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="agent-connection-base-url">Base URL</Label>
              <Input
                id="agent-connection-base-url"
                value={form.base_url}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    base_url: event.target.value,
                  }))
                }
                placeholder="https://..."
                autoComplete="off"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="agent-connection-model">Default model</Label>
              <Input
                id="agent-connection-model"
                value={form.default_model}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    default_model: event.target.value,
                  }))
                }
                placeholder="Provider default"
                autoComplete="off"
              />
            </div>
          </div>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              className="h-3.5 w-3.5"
              checked={form.is_default}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  is_default: event.target.checked,
                }))
              }
            />
            Use as this agent's default connection for new chats
          </label>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={resetForm}
              disabled={isSaving}
            >
              Cancel
            </Button>
            <Button type="button" size="sm" onClick={save} disabled={isSaving}>
              {isSaving ? <IconSpinner className="mr-1 h-3.5 w-3.5" /> : null}
              Save
            </Button>
          </div>
        </div>
      ) : isLoading ? (
        <div className="flex items-center justify-center py-3">
          <IconSpinner className="h-4 w-4" />
        </div>
      ) : connections.length === 0 ? (
        nativeQuery.isError ? (
          <div className="space-y-1.5 rounded-lg border border-dashed border-destructive/40 bg-destructive/5 px-3 py-2.5">
            <p className="text-xs font-medium text-foreground">
              Could not detect native configuration
            </p>
            <p className="text-[11px] leading-4 text-muted-foreground">
              The backend may be outdated (restart it) or the config file is
              unreadable.{" "}
              {nativeQuery.error instanceof Error
                ? nativeQuery.error.message
                : ""}
            </p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 px-2 text-xs"
              disabled={nativeQuery.isFetching}
              onClick={() => nativeQuery.refetch()}
            >
              {nativeQuery.isFetching ? (
                <IconSpinner className="mr-1 h-3 w-3" />
              ) : null}
              Retry
            </Button>
          </div>
        ) : nativeQuery.data ? (
          <div className="space-y-1.5 rounded-lg border border-border bg-muted/30 px-3 py-2.5">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-medium text-foreground">
                Default configuration detected
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 px-2 text-xs"
                disabled={importMutation.isPending}
                onClick={() => importMutation.mutate({ agentId })}
              >
                {importMutation.isPending ? (
                  <IconSpinner className="mr-1 h-3 w-3" />
                ) : null}
                Import
              </Button>
            </div>
            <p
              className="truncate font-mono text-[11px] text-muted-foreground"
              title={nativeQuery.data.sourcePath}
            >
              {nativeQuery.data.sourcePath}
            </p>
            <p
              className="truncate text-[11px] text-muted-foreground"
              title={[
                nativeQuery.data.baseUrl,
                nativeQuery.data.defaultModel,
                nativeQuery.data.hasApiKey ? "API key found" : "No API key found",
              ]
                .filter(Boolean)
                .join(" · ")}
            >
              {[
                nativeQuery.data.baseUrl,
                nativeQuery.data.defaultModel,
                nativeQuery.data.hasApiKey
                  ? "API key found"
                  : "No API key found",
              ]
                .filter(Boolean)
                .join(" · ") || "No endpoints or models configured"}
            </p>
          </div>
        ) : (
          <p className="rounded-lg border border-dashed border-border px-3 py-2.5 text-xs text-muted-foreground">
            No providers yet.
          </p>
        )
      ) : (
        <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
          {connections.map((connection) => (
            <div
              key={connection.id}
              className="flex items-center justify-between gap-2 px-3 py-2"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">
                    {connection.name}
                  </span>
                  {connection.isDefault && (
                    <Badge variant="secondary" className="text-[10px]">
                      Default
                    </Badge>
                  )}
                </div>
                <p
                  className="mt-0.5 truncate text-[11px] text-muted-foreground"
                  title={[
                    PROTOCOL_OPTIONS.find((option) => option.value === connection.protocol)
                      ?.label ?? connection.protocol,
                    connection.baseUrl,
                    connection.defaultModel,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                >
                  {PROTOCOL_OPTIONS.find(
                    (option) => option.value === connection.protocol,
                  )?.label ?? connection.protocol}
                  {connection.baseUrl ? ` · ${connection.baseUrl}` : ""}
                  {connection.defaultModel ? ` · ${connection.defaultModel}` : ""}
                </p>
              </div>
              <div className="flex flex-shrink-0 items-center gap-1">
                {!connection.isDefault && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    disabled={setDefaultMutation.isPending}
                    onClick={() => setDefaultMutation.mutate({ id: connection.id })}
                  >
                    <RotateCcw className="mr-1 h-3 w-3" />
                    Default
                  </Button>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={() => startEdit(connection)}
                >
                  Edit
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  disabled={deleteMutation.isPending}
                  onClick={() => {
                    if (window.confirm(`Delete ${connection.name}?`)) {
                      deleteMutation.mutate({ id: connection.id })
                    }
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
