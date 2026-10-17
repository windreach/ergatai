import React, { useMemo, useCallback } from "react"
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
} from "../../../components/ui/context-menu"
import { Kbd } from "../../../components/ui/kbd"
import { isMac } from "../../../lib/utils"
import { isDesktopApp } from "../../../lib/utils/platform"
import type { ConversationMeta } from "../stores/conversation-store"
import { useResolvedHotkeyDisplay } from "../../../lib/hotkeys"
import { exportChat, copyChat, type ExportFormat } from "../lib/export-chat"
import { toast } from "sonner"

const openInNewWindow = async (chatId: string, conversationId: string) => {
  const result = await window.desktopApi?.newWindow({ chatId, conversationId: conversationId })
  if (result?.blocked) {
    toast.info("This workspace is already open in another window", {
      description: "Switching to the existing window.",
      duration: 3000,
    })
  }
}

// Platform-aware keyboard shortcut for close tab
// Uses custom hotkey from settings if configured
const useCloseTabShortcut = () => {
  const archiveAgentHotkey = useResolvedHotkeyDisplay("archive-agent")
  return useMemo(() => {
    if (!isMac) return "Alt+Ctrl+W"
    return archiveAgentHotkey || "⌘W"
  }, [archiveAgentHotkey])
}

interface ConversationContextMenuProps {
  conversation: ConversationMeta
  isPinned: boolean
  onTogglePin: (conversationId: string) => void
  onRename: (conversation: ConversationMeta) => void
  onArchive: (conversationId: string) => void
  onArchiveOthers: (conversationId: string) => void
  onArchiveAllBelow?: (conversationId: string) => void
  isOnlyChat: boolean
  currentIndex?: number
  totalCount?: number
  showCloseTabOptions?: boolean
  onCloseTab?: (conversationId: string) => void
  onCloseOtherTabs?: (conversationId: string) => void
  onCloseTabsToRight?: (conversationId: string, visualIndex: number) => void
  visualIndex?: number
  hasTabsToRight?: boolean
  canCloseOtherTabs?: boolean
  /** Parent chat ID for export functionality */
  chatId?: string | null
  /** Open this conversation in split view */
  onOpenInSplit?: (conversationId: string) => void
  /** Close the current split view */
  onCloseSplit?: () => void
  /** Whether this tab is currently selected for command/input focus */
  isActiveTab?: boolean
  /** Whether this tab is already in split panes */
  isSplitTab?: boolean
  /** Remove this specific pane from split */
  onRemoveFromSplit?: (conversationId: string) => void
  /** Number of panes currently in split */
  splitPaneCount?: number
}

export function ConversationContextMenu({
  conversation,
  isPinned,
  onTogglePin,
  onRename,
  onArchive,
  onArchiveOthers,
  onArchiveAllBelow,
  isOnlyChat,
  currentIndex,
  totalCount,
  showCloseTabOptions = false,
  onCloseTab,
  onCloseOtherTabs,
  onCloseTabsToRight,
  visualIndex = 0,
  hasTabsToRight = false,
  canCloseOtherTabs = false,
  chatId,
  onOpenInSplit,
  onCloseSplit,
  isActiveTab = false,
  isSplitTab = false,
  onRemoveFromSplit,
  splitPaneCount = 0,
}: ConversationContextMenuProps) {
  const closeTabShortcut = useCloseTabShortcut()

  const handleExport = useCallback((format: ExportFormat) => {
    if (!chatId) return
    exportChat({ chatId, conversationId: conversation.id, format })
  }, [chatId, conversation.id])

  const handleCopy = useCallback((format: ExportFormat) => {
    if (!chatId) return
    copyChat({ chatId, conversationId: conversation.id, format })
  }, [chatId, conversation.id])

  return (
    <ContextMenuContent className="w-48">
      <ContextMenuItem onClick={() => onTogglePin(conversation.id)}>
        {isPinned ? "Unpin conversation" : "Pin conversation"}
      </ContextMenuItem>
      <ContextMenuItem onClick={() => onRename(conversation)}>
        Rename conversation
      </ContextMenuItem>
      {chatId && (
        <ContextMenuSub>
          <ContextMenuSubTrigger>Export conversation</ContextMenuSubTrigger>
          <ContextMenuSubContent sideOffset={6} alignOffset={-4}>
            <ContextMenuItem onClick={() => handleExport("markdown")}>
              Download as Markdown
            </ContextMenuItem>
            <ContextMenuItem onClick={() => handleExport("json")}>
              Download as JSON
            </ContextMenuItem>
            <ContextMenuItem onClick={() => handleExport("text")}>
              Download as Text
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => handleCopy("markdown")}>
              Copy as Markdown
            </ContextMenuItem>
            <ContextMenuItem onClick={() => handleCopy("json")}>
              Copy as JSON
            </ContextMenuItem>
            <ContextMenuItem onClick={() => handleCopy("text")}>
              Copy as Text
            </ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
      )}
      {isDesktopApp() && chatId && (
        <ContextMenuItem onClick={() => openInNewWindow(chatId, conversation.id)}>
          Open in new window
        </ContextMenuItem>
      )}
      {isSplitTab ? (
        <>
          {splitPaneCount > 2 && onRemoveFromSplit && (
            <ContextMenuItem onClick={() => onRemoveFromSplit(conversation.id)}>
              Remove from split
            </ContextMenuItem>
          )}
          {onCloseSplit && (
            <ContextMenuItem onClick={onCloseSplit}>
              Separate conversations
            </ContextMenuItem>
          )}
        </>
      ) : onOpenInSplit ? (
        <ContextMenuItem
          onClick={() => onOpenInSplit(conversation.id)}
          disabled={isActiveTab || isOnlyChat || splitPaneCount >= 4}
        >
          Add as split
        </ContextMenuItem>
      ) : null}
      <ContextMenuSeparator />

      {showCloseTabOptions ? (
        <>
          <ContextMenuItem
            onClick={() => onCloseTab?.(conversation.id)}
            className="justify-between"
            disabled={isOnlyChat}
          >
            Close conversation
            {!isOnlyChat && <Kbd>{closeTabShortcut}</Kbd>}
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() => onCloseOtherTabs?.(conversation.id)}
            disabled={!canCloseOtherTabs}
          >
            Close other conversations
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() => onCloseTabsToRight?.(conversation.id, visualIndex)}
            disabled={!hasTabsToRight}
          >
            Close conversations to the right
          </ContextMenuItem>
        </>
      ) : (
        <>
          <ContextMenuItem
            onClick={() => onArchive(conversation.id)}
            className="justify-between"
            disabled={isOnlyChat}
          >
            Archive conversation
            {!isOnlyChat && <Kbd>{closeTabShortcut}</Kbd>}
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() => onArchiveAllBelow?.(conversation.id)}
            disabled={
              currentIndex === undefined ||
              currentIndex >= (totalCount || 0) - 1
            }
          >
            Archive conversations below
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() => onArchiveOthers(conversation.id)}
            disabled={isOnlyChat}
          >
            Archive other conversations
          </ContextMenuItem>
        </>
      )}
    </ContextMenuContent>
  )
}
