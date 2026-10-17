import React, { useMemo, useCallback } from "react"
import { MoreVertical } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../../../components/ui/dropdown-menu"
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

interface ConversationDropdownMenuProps {
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

export function ConversationDropdownMenu({
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
  chatId,
  onOpenInSplit,
  onCloseSplit,
  isActiveTab = false,
  isSplitTab = false,
  onRemoveFromSplit,
  splitPaneCount = 0,
}: ConversationDropdownMenuProps) {
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
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          tabIndex={-1}
          aria-label={`Manage conversation ${conversation.name || conversation.id}`}
          onClick={(event) => event.stopPropagation()}
          className="flex-shrink-0 rounded-md p-0.5 text-muted-foreground hover:text-foreground active:text-foreground transition-[opacity,transform,color] duration-150 ease-out opacity-0 scale-95 pointer-events-none group-hover:opacity-100 group-hover:scale-100 group-hover:pointer-events-auto active:scale-[0.97]"
        >
          <MoreVertical className="h-3.5 w-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem onSelect={() => onTogglePin(conversation.id)}>
          {isPinned ? "Unpin conversation" : "Pin conversation"}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onRename(conversation)}>
          Rename conversation
        </DropdownMenuItem>
        {chatId && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Export conversation</DropdownMenuSubTrigger>
            <DropdownMenuSubContent sideOffset={6} alignOffset={-4}>
              <DropdownMenuItem onSelect={() => handleExport("markdown")}>
                Download as Markdown
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => handleExport("json")}>
                Download as JSON
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => handleExport("text")}>
                Download as Text
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => handleCopy("markdown")}>
                Copy as Markdown
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => handleCopy("json")}>
                Copy as JSON
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => handleCopy("text")}>
                Copy as Text
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
        {isDesktopApp() && chatId && (
          <DropdownMenuItem onSelect={() => openInNewWindow(chatId, conversation.id)}>
            Open in new window
          </DropdownMenuItem>
        )}
        {isSplitTab ? (
          <>
            {splitPaneCount > 2 && onRemoveFromSplit && (
              <DropdownMenuItem onSelect={() => onRemoveFromSplit(conversation.id)}>
                Remove from split
              </DropdownMenuItem>
            )}
            {onCloseSplit && (
              <DropdownMenuItem onSelect={onCloseSplit}>
                Separate conversations
              </DropdownMenuItem>
            )}
          </>
        ) : onOpenInSplit ? (
          <DropdownMenuItem
            onSelect={() => onOpenInSplit(conversation.id)}
            disabled={isActiveTab || isOnlyChat || splitPaneCount >= 4}
          >
            Add as split
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault()
            onArchive(conversation.id)
          }}
          className="justify-between"
          disabled={isOnlyChat}
        >
          Archive conversation
          {!isOnlyChat && <Kbd>{closeTabShortcut}</Kbd>}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => onArchiveAllBelow?.(conversation.id)}
          disabled={
            currentIndex === undefined ||
            currentIndex >= (totalCount || 0) - 1
          }
        >
          Archive conversations below
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => onArchiveOthers(conversation.id)}
          disabled={isOnlyChat}
        >
          Archive other conversations
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
