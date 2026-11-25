import i18n from "@/lib/i18n"

import { Badge } from "../../../components/ui/badge"
import { Button } from "../../../components/ui/button"
import { Copy, RotateCcw, Trash2 } from "lucide-react"

export type ProviderProtocol = "anthropic" | "openai_compatible" | "opencode"

export type ProviderConnection = {
  id: string
  name: string
  /** Owning agent profile name. A connection belongs to exactly one agent. */
  agentId: string
  protocol: ProviderProtocol
  baseUrl?: string | null
  authRef?: string | null
  defaultModel?: string | null
  /** Masked API key (e.g. "sk-abc••••••••"), null when not configured. */
  apiKeyHint?: string | null
  isDefault: boolean
  createdAt: number
  updatedAt: number
}

const PROTOCOL_LABELS: Record<ProviderProtocol, string> = {
  anthropic: "Anthropic",
  openai_compatible: "OpenAI-compatible",
  opencode: "OpenCode",
}

interface AgentConnectionRowProps {
  connection: ProviderConnection
  /** Render an informational row without edit/delete actions. */
  readOnly?: boolean
  /** Highlight the inherited connection that launches actually use. */
  inheritedActive?: boolean
  isSettingDefault?: boolean
  isDeleting?: boolean
  /** Copy an inherited connection into this agent so it becomes editable. */
  onCopyToAgent?: (connection: ProviderConnection) => void
  isCopying?: boolean
  onSetDefault?: (id: string) => void
  onEdit?: (connection: ProviderConnection) => void
  onDelete?: (connection: ProviderConnection) => void
}

export function AgentConnectionRow({
  connection,
  readOnly = false,
  inheritedActive = false,
  isSettingDefault = false,
  isDeleting = false,
  onCopyToAgent,
  isCopying = false,
  onSetDefault,
  onEdit,
  onDelete,
}: AgentConnectionRowProps) {
  const protocolLabel = PROTOCOL_LABELS[connection.protocol] ?? connection.protocol
  const summary = [protocolLabel, connection.baseUrl, connection.defaultModel]
    .filter(Boolean)
    .join(" · ")

  return (
    <div className="flex items-center justify-between gap-2 px-3 py-2">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{connection.name}</span>
          {connection.isDefault && (
            <Badge variant="secondary" className="text-[10px]">
              Default
            </Badge>
          )}
          {readOnly && (
            <Badge variant="outline" className="text-[10px]">
              {i18n.t("Inherited")}
            </Badge>
          )}
          {readOnly && inheritedActive && (
            <Badge variant="default" className="text-[10px]">
              {i18n.t("In use")}
            </Badge>
          )}
          {connection.apiKeyHint ? (
            <Badge
              variant="outline"
              className="flex-shrink-0 font-mono text-[10px] font-normal"
              title="API key configured"
            >
              {connection.apiKeyHint}
            </Badge>
          ) : connection.apiKeyHint === null ? (
            <Badge
              variant="outline"
              className="flex-shrink-0 text-[10px] font-normal text-muted-foreground"
            >
              No key
            </Badge>
          ) : null}
        </div>
        <p
          className="mt-0.5 truncate text-[11px] text-muted-foreground"
          title={summary}
        >
          {summary}
        </p>
      </div>
      {readOnly && onCopyToAgent && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 flex-shrink-0 px-2 text-xs"
          disabled={isCopying}
          onClick={() => onCopyToAgent(connection)}
        >
          <Copy className="mr-1 h-3 w-3" />
          {i18n.t("Copy to this agent")}
        </Button>
      )}
      {!readOnly && (
        <div className="flex flex-shrink-0 items-center gap-1">
          {!connection.isDefault && typeof onSetDefault === "function" && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              disabled={isSettingDefault}
              onClick={() => onSetDefault(connection.id)}
            >
              <RotateCcw className="mr-1 h-3 w-3" />
              Default
            </Button>
          )}
          {typeof onEdit === "function" && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => onEdit(connection)}
            >
              Edit
            </Button>
          )}
          {typeof onDelete === "function" && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              aria-label={i18n.t('Delete')}
              disabled={isDeleting}
              onClick={() => {
                if (
                  window.confirm(
                    i18n.t("Delete {{name}}?", { name: connection.name }),
                  )
                ) {
                  onDelete(connection)
                }
              }}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
