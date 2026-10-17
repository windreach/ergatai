import { Bot, Users, type LucideIcon } from "lucide-react"

import type { CollaborationMode } from "../atoms"

export type { CollaborationMode }

export const COLLABORATION_MODES = ["supervisor", "group"] as const

export type CollaborationModeUiConfig = {
  id: CollaborationMode
  label: string
  icon: LucideIcon
  workspaceSearchPlaceholder: string
  conversationSearchPlaceholder: string
  pinnedTitle: string
  recentTitle: string
  allTitle: string
  workspaceButtonLabel: string
  workspaceButtonTooltip: string
  conversationButtonLabel: string
  conversationButtonTooltip: string
}

const COLLABORATION_MODE_CONFIG: Record<
  CollaborationMode,
  CollaborationModeUiConfig
> = {
  supervisor: {
    id: "supervisor",
    label: "Supervisor",
    icon: Bot,
    workspaceSearchPlaceholder: "Search workspaces...",
    conversationSearchPlaceholder: "Search chats...",
    pinnedTitle: "Pinned chats",
    recentTitle: "Recent chats",
    allTitle: "Chats",
    workspaceButtonLabel: "New Workspace",
    workspaceButtonTooltip: "Start a new workspace",
    conversationButtonLabel: "New Chat",
    conversationButtonTooltip: "Start a new chat",
  },
  group: {
    id: "group",
    label: "Group",
    icon: Users,
    workspaceSearchPlaceholder: "Search workspaces...",
    conversationSearchPlaceholder: "Search chats...",
    pinnedTitle: "Pinned chats",
    recentTitle: "Recent chats",
    allTitle: "Chats",
    workspaceButtonLabel: "New Workspace",
    workspaceButtonTooltip: "Start a new workspace",
    conversationButtonLabel: "New Chat",
    conversationButtonTooltip: "Start a new chat",
  },
}

export function getCollaborationModeConfig(mode: CollaborationMode) {
  return COLLABORATION_MODE_CONFIG[mode]
}
