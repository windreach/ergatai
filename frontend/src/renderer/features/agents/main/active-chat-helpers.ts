"use client"

import * as React from "react"
import { clearConversationRuntimeCaches } from "../stores/conversation-runtime-cleanup"
import type { MessagePart } from "../stores/message-store"
import {
  ClaudeCodeIcon,
  CursorIcon,
} from "../../../components/ui/icons"
import { CodexIcon } from "./active-chat-ui"

// Module-level scroll position cache moved to use-scroll-management hook
// (kept here for API parity)
export function clearRuntimeCachesForConversation(conversationId: string) {
  clearConversationRuntimeCaches(conversationId)
  // scrollPositionCache is now managed in use-scroll-management hook
}

// Exploring tools - these get grouped when 2+ consecutive
export const EXPLORING_TOOLS = new Set([
  "tool-Read",
  "tool-Grep",
  "tool-Glob",
  "tool-WebSearch",
  "tool-WebFetch",
])

// Group consecutive exploring tools into exploring-group
export function groupExploringTools(parts: MessagePart[], nestedToolIds: Set<string>): MessagePart[] {
  const result: MessagePart[] = []
  let currentGroup: MessagePart[] = []

  for (const part of parts) {
    // Skip nested tools - they shouldn't be grouped, they render inside parent
    const isNested = part.toolCallId && nestedToolIds.has(part.toolCallId)

    if (EXPLORING_TOOLS.has(part.type) && !isNested) {
      currentGroup.push(part)
    } else {
      // Flush group if 3+
      if (currentGroup.length >= 3) {
        result.push({ type: "exploring-group", parts: currentGroup })
      } else {
        result.push(...currentGroup)
      }
      currentGroup = []
      result.push(part)
    }
  }
  // Flush remaining
  if (currentGroup.length >= 3) {
    result.push({ type: "exploring-group", parts: currentGroup })
  } else {
    result.push(...currentGroup)
  }
  return result
}

// Get the ID of the first conversation by creation date
export function getFirstConversationId(
  conversations:
    | Array<{ id: string; created_at?: Date | string | null }>
    | undefined,
): string | null {
  if (!conversations?.length) return null
  const sorted = [...conversations].sort(
    (a, b) =>
      (a.created_at ? new Date(a.created_at).getTime() : 0) -
      (b.created_at ? new Date(b.created_at).getTime() : 0),
  )
  return sorted[0]?.id ?? null
}

// Layout constants for chat header and sticky messages
export const CHAT_LAYOUT = {
  // Padding top for chat content
  paddingTopSidebarOpen: "pt-12", // When sidebar open (absolute header overlay)
  paddingTopSidebarClosed: "pt-4", // When sidebar closed (regular header)
  paddingTopMobile: "pt-14", // Mobile has header
  // Sticky message top position (title is now in flex above scroll, so top-0)
  stickyTopSidebarOpen: "top-0", // When sidebar open (desktop, absolute header)
  stickyTopSidebarClosed: "top-0", // When sidebar closed (desktop, flex header)
  stickyTopMobile: "top-0", // Mobile (flex header, so top-0)
  // Header padding when absolute
  headerPaddingSidebarOpen: "pt-1.5 pb-12 px-3 pl-2",
  headerPaddingSidebarClosed: "p-2 pt-1.5",
} as const

// Agent providers
export const agents = [
  { id: "claude-code", name: "Claude Code", hasModels: true },
  { id: "cursor", name: "Cursor CLI", disabled: true },
  { id: "codex", name: "OpenAI Codex", disabled: true },
]

// Helper function to get agent icon
export const getAgentIcon = (agentId: string, className?: string) => {
  switch (agentId) {
    case "claude-code":
      return React.createElement(ClaudeCodeIcon, { className })
    case "cursor":
      return React.createElement(CursorIcon, { className })
    case "codex":
      return React.createElement(CodexIcon, { className })
    default:
      return null
  }
}
