import i18n from "@/lib/i18n"
"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { trpc } from "../../../lib/trpc"
import { Button } from "../../../components/ui/button"
import { Input } from "../../../components/ui/input"
import { Label } from "../../../components/ui/label"
// Protocol is now derived automatically from the owning agent.
import { IconSpinner } from "../../../icons"
import { toast } from "sonner"
import { Plus } from "lucide-react"
import {
  AgentConnectionRow,
  type ProviderConnection,
  type ProviderProtocol,
} from "./agent-connection-row"
import { ModelAutocompleteInput } from "./model-autocomplete-input"
import {
  InheritedConnections,
  useInheritedConnections,
} from "./inherited-connections"
import { NativeConnectionState } from "./native-connection-state"

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
  /**
   * Optional profile whose provider connections are inherited when this agent
   * has none of its own (custom profiles that wrap a bundled runtime).
   */
  fallbackAgentId?: string
  fallbackAgentDisplayName?: string
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
  fallbackAgentId,
  fallbackAgentDisplayName,
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
  const inheritedConnections = useInheritedConnections(
    connectionsQuery.data,
    agentId,
    fallbackAgentId,
  )
  const inheritedFrom =
    fallbackAgentDisplayName ?? fallbackAgentId ?? "the runtime agent"
  // Models detected for this agent profile, used as suggestions in the
  // default-model field. Raw ids are kept so they match what the agent
  // expects (e.g. "opencode/longcat-2.5-free").
  const modelsQuery = trpc.ergatai.getAgentProfileModels.useQuery(
    { profileName: agentId },
    { staleTime: 5 * 60 * 1000, refetchOnWindowFocus: false, retry: false },
  )
  const modelOptions = useMemo(() => {
    const details = modelsQuery.data?.model_details ?? []
    const ids =
      details.length > 0
        ? details.map((detail) => detail.id)
        : (modelsQuery.data?.models ?? [])
    return Array.from(
      new Set(ids.filter((id) => id.trim() && id !== "default")),
    )
  }, [modelsQuery.data])
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
  const [keyTouched, setKeyTouched] = useState(false)

  const saveMutation = trpc.ergatai.saveProviderConnection.useMutation({
    onSuccess: () => {
      toast.success("Provider saved")
      void utils.ergatai.listProviderConnections.invalidate()
      // The default model shown by the new-chat model picker is derived from
      // the default connection, so refresh the profile catalogue too.
      void utils.ergatai.getAgentProfileModels.invalidate()
      resetForm()
    },
    onError: (error) => {
      toast.error(i18n.t("Failed to save provider: {{message}}", { message: error.message }))
    },
  })

  const setDefaultMutation =
    trpc.ergatai.setDefaultProviderConnection.useMutation({
      onSuccess: () => {
        toast.success("Default provider updated")
        void utils.ergatai.listProviderConnections.invalidate()
        // The default model shown by the new-chat model picker is derived from
        // the default connection, so refresh the profile catalogue too.
        void utils.ergatai.getAgentProfileModels.invalidate()
      },
      onError: (error) => {
        toast.error(i18n.t("Failed to set default: {{message}}", { message: error.message }))
      },
    })

  const deleteMutation = trpc.ergatai.deleteProviderConnection.useMutation({
    onSuccess: (data) => {
      if (data.deleted) toast.success("Provider deleted")
      void utils.ergatai.listProviderConnections.invalidate()
      // The default model shown by the new-chat model picker is derived from
      // the default connection, so refresh the profile catalogue too.
      void utils.ergatai.getAgentProfileModels.invalidate()
      if (editingId) resetForm()
    },
    onError: (error) => {
      toast.error(i18n.t("Failed to delete provider: {{message}}", { message: error.message }))
    },
  })

  const copyToAgentMutation = trpc.ergatai.copyProviderConnection.useMutation({
    onSuccess: () => {
      toast.success(i18n.t("Provider copied to this agent"))
      void utils.ergatai.listProviderConnections.invalidate()
      // The copied connection becomes this agent's default model source.
      void utils.ergatai.getAgentProfileModels.invalidate()
    },
    onError: (error) => {
      toast.error(
        i18n.t("Failed to copy provider: {{message}}", {
          message: error.message,
        }),
      )
    },
  })

  const importMutation = trpc.ergatai.importNativeConnection.useMutation({
    onSuccess: (data) => {
      toast.success(i18n.t("Provider \"{{name}}\" imported from {{agent}} config", { name: data.connection.name, agent: agentDisplayName }))
      void utils.ergatai.listProviderConnections.invalidate()
      // The default model shown by the new-chat model picker is derived from
      // the default connection, so refresh the profile catalogue too.
      void utils.ergatai.getAgentProfileModels.invalidate()
    },
    onError: (error) => {
      toast.error(i18n.t("Failed to import configuration: {{message}}", { message: error.message }))
    },
  })

  const isLoading = connectionsQuery.isLoading
  const editingConnection = editingId
    ? connections.find((connection) => connection.id === editingId)
    : undefined

  // Import the agent's default configuration automatically the first time it
  // is detected. One attempt per source path keeps failures from looping; the
  // retry button below covers that case.
  const autoImportedSource = useRef<string | null>(null)
  const nativeSourcePath = nativeQuery.data?.sourcePath
  const importNative = importMutation.mutate
  useEffect(() => {
    if (!nativeSourcePath) return
    if (isLoading || connections.length > 0 || inheritedConnections.length > 0 || showForm) return
    const sourceKey = `${agentId}:${nativeSourcePath}`
    if (autoImportedSource.current === sourceKey) return
    autoImportedSource.current = sourceKey
    importNative({ agentId })
  }, [
    agentId,
    nativeSourcePath,
    isLoading,
    connections.length,
    inheritedConnections.length,
    showForm,
    importNative,
  ])

  function resetForm() {
    setForm({ ...EMPTY_FORM })
    setEditingId(null)
    setShowForm(false)
    setKeyTouched(false)
  }

  function protocolForAgent(id: string): ProviderProtocol {
    if (id === "claude-code") return "anthropic"
    if (id === "codex") return "openai_compatible"
    if (id === "opencode") return "opencode"
    return "openai_compatible"
  }

  function startCreate() {
    // Custom profiles wrapping a bundled runtime should default to the
    // runtime's protocol (e.g. "opencode") rather than openai_compatible.
    setForm({
      ...EMPTY_FORM,
      protocol: protocolForAgent(fallbackAgentId ?? agentId),
    })
    setEditingId(null)
    setShowForm(true)
    setKeyTouched(false)
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
    setKeyTouched(false)
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

  const isSaving = saveMutation.isPending

  return (
    // `min-w-0` is required: this section is rendered as a grid item inside
    // DialogContent. Without it the nowrap provider summary (truncate) raises
    // the grid item's automatic minimum width, so the whole list overflows the
    // fixed-width dialog instead of ellipsizing.
    <div className="min-w-0 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-foreground">{i18n.t('Providers')}</p>
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
              <Label htmlFor="agent-connection-name">{i18n.t('Name')}</Label>
              <Input
                id="agent-connection-name"
                value={form.name}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    name: event.target.value,
                  }))
                }
                placeholder={i18n.t('Production key')}
                autoComplete="off"
              />
            </div>
            {/* Protocol is derived automatically from the owning agent and is not user-editable. */}
            <div className="col-span-2 space-y-1.5">
              <Label htmlFor="agent-connection-key">{i18n.t('API key')}</Label>
              <Input
                id="agent-connection-key"
                // Show the masked key as the actual value while browsing;
                // focus clears it so a new secret can be typed. Untouched
                // fields always submit an empty value (keep current key).
                type="password"
                value={
                  form.api_key ||
                  (editingId && !keyTouched
                    ? (editingConnection?.apiKeyHint ?? "")
                    : "")
                }
                onFocus={() => {
                  if (editingId && !keyTouched) setKeyTouched(true)
                }}
                onBlur={() => {
                  if (editingId && !form.api_key) setKeyTouched(false)
                }}
                onChange={(event) => {
                  setKeyTouched(true)
                  setForm((current) => ({
                    ...current,
                    api_key: event.target.value,
                  }))
                }}
                placeholder={
                  editingId
                    ? editingConnection?.apiKeyHint === null
                      ? "No API key saved — enter a key"
                      : "Enter a new key · leave blank to keep the current one"
                    : "sk-..."
                }
                autoComplete="off"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="agent-connection-base-url">{i18n.t('Base URL')}</Label>
              <Input
                id="agent-connection-base-url"
                value={form.base_url}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    base_url: event.target.value,
                  }))
                }
                placeholder={i18n.t('https://...')}
                autoComplete="off"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="agent-connection-model">{i18n.t('Default model')}</Label>
              <ModelAutocompleteInput
                id="agent-connection-model"
                value={form.default_model}
                onChange={(value) =>
                  setForm((current) => ({
                    ...current,
                    default_model: value,
                  }))
                }
                options={modelOptions}
                placeholder={
                  modelOptions.length > 0
                    ? "Type to search models"
                    : i18n.t('Provider default')
                }
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
        inheritedConnections.length > 0 ? (
          <InheritedConnections
            connections={inheritedConnections}
            fromDisplayName={inheritedFrom}
            onCopyToAgent={(connection) =>
              copyToAgentMutation.mutate({
                id: connection.id,
                agentId,
              })
            }
            isCopying={copyToAgentMutation.isPending}
          />
        ) : (
          <NativeConnectionState
            isLoading={nativeQuery.isLoading}
            isError={nativeQuery.isError}
            errorMessage={
              nativeQuery.error instanceof Error
                ? nativeQuery.error.message
                : undefined
            }
            isFetching={nativeQuery.isFetching}
            onRetry={() => nativeQuery.refetch()}
            config={nativeQuery.data}
            isImporting={importMutation.isPending}
            isImportError={importMutation.isError}
            importErrorMessage={
              importMutation.error instanceof Error
                ? importMutation.error.message
                : undefined
            }
            onImport={() => importMutation.mutate({ agentId })}
          />
        )
      ) : (
        <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
          {connections.map((connection) => (
            <AgentConnectionRow
              key={connection.id}
              connection={connection}
              isSettingDefault={setDefaultMutation.isPending}
              isDeleting={deleteMutation.isPending}
              onSetDefault={(id) => setDefaultMutation.mutate({ id })}
              onEdit={startEdit}
              onDelete={(target) => deleteMutation.mutate({ id: target.id })}
            />
          ))}
        </div>
      )}
    </div>
  )
}