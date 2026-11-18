import i18n from "@/lib/i18n"
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

const COLLABORATION_MODE_META: Record<
  CollaborationMode,
  Pick<CollaborationModeUiConfig, "id" | "label" | "icon" | "allTitle">
> = {
  supervisor: {
    id: "supervisor",
    label: "Supervisor",
    icon: Bot,
    allTitle: "Chats",
  },
  group: {
    id: "group",
    label: "Group",
    icon: Users,
    allTitle: "Chats",
  },
}

// Resolve translations when the config is read (i.e. during render), not when
// this module is first imported. Module-level i18n.t() calls freeze the strings
// in whatever language was active at startup and leak the old language after a
// runtime language switch.
export function getCollaborationModeConfig(
  mode: CollaborationMode,
): CollaborationModeUiConfig {
  return {
    ...COLLABORATION_MODE_META[mode],
    workspaceSearchPlaceholder: i18n.t("Search workspaces..."),
    conversationSearchPlaceholder: i18n.t("Search chats..."),
    pinnedTitle: i18n.t("Pinned chats"),
    recentTitle: i18n.t("Recent chats"),
    workspaceButtonLabel: i18n.t("New Workspace"),
    workspaceButtonTooltip: i18n.t("Start a new workspace"),
    conversationButtonLabel: i18n.t("New Chat"),
    conversationButtonTooltip: i18n.t("Start a new chat"),
  }
}