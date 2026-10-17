export type PanelTargetKind =
  | "agent"
  | "chat"
  | "file"
  | "diff"
  | "terminal"
  | "plan"
  | "widget"

export type PanelId =
  | "details"
  | "side-chat"
  | "diff"
  | "file-viewer"
  | "terminal"
  | "plan"

export type PanelLinkUpdateSource =
  | "user"
  | "runtime"
  | "migration"
  | "restore"

export interface PanelTarget {
  kind: PanelTargetKind
  id: string
  agentId?: string
  chatId?: string
  workspaceId?: string
  path?: string
  metadata?: Record<string, unknown>
}

export interface PanelState {
  open: boolean
  target: PanelTarget | null
  pinned: boolean
  displayMode?: string
}

export interface PanelLinkScopeState {
  activeTarget: PanelTarget | null
  activeTargetSource: PanelLinkUpdateSource
  panels: Partial<Record<PanelId, PanelState>>
  updatedAt: string
}

export interface PanelLinkFocusOptions {
  panelIds?: PanelId[]
  replaceExclusive?: boolean
}

export type PanelLinkCommand =
  | {
      type: "focus-target"
      target: PanelTarget
      source: PanelLinkUpdateSource
      options?: PanelLinkFocusOptions
    }
  | {
      type: "open-panel"
      panelId: PanelId
      target?: PanelTarget
      source: PanelLinkUpdateSource
      displayMode?: string
      replaceExclusive?: boolean
    }
  | {
      type: "close-panel"
      panelId: PanelId
      source: PanelLinkUpdateSource
    }
  | {
      type: "toggle-panel"
      panelId: PanelId
      target?: PanelTarget
      source: PanelLinkUpdateSource
      displayMode?: string
      replaceExclusive?: boolean
    }
  | {
      type: "set-panel-pinned"
      panelId: PanelId
      pinned: boolean
      source: PanelLinkUpdateSource
    }
  | {
      type: "sync-panel-target"
      panelId: PanelId
      target: PanelTarget | null
      source: PanelLinkUpdateSource
      displayMode?: string
    }
  | {
      type: "sync-panel"
      panelId: PanelId
      open: boolean
      target?: PanelTarget | null
      source: PanelLinkUpdateSource
      displayMode?: string
      pinned?: boolean
    }

export type PanelLinkRuntimeEvent =
  | {
      type: "agent-status-changed"
      agentId: string
      chatId: string
      workspaceId?: string
      status: "pending" | "running" | "completed" | "failed" | "idle"
      requestId?: number
    }
  | {
      type: "active-file-changed"
      chatId: string
      workspaceId?: string
      path: string
    }
  | {
      type: "terminal-focused"
      chatId: string
      workspaceId?: string
      terminalId: string
    }
  | {
      type: "side-chat-changed"
      chatId: string
      workspaceId?: string
      sideChatId: string
      agentId?: string
    }

export interface PanelLinkSnapshot {
  scopeKey: string
  state: PanelLinkScopeState
}
