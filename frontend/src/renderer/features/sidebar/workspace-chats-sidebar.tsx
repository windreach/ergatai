"use client"

import React, { useMemo, useState, useCallback, useRef, useEffect, memo } from "react"
import { createPortal } from "react-dom"
import { useAtom, useAtomValue, useSetAtom } from "jotai"
import { motion, AnimatePresence } from "motion/react"
import { Button } from "../../components/ui/button"
import { Input } from "../../components/ui/input"
import { cn } from "../../lib/utils"
import {
  agentsConversationUnseenChangesAtom,
  selectedAgentChatIdAtom,
  previousAgentChatIdAtom,
  MAX_CHAT_AGENT_LOGOS,
  chatAgentLogosAtom,
  createChatAgentLogos,
  type ChatAgentLogo,
  justCreatedIdsAtom,
  pendingUserQuestionsAtom,
  registeredAgentsAtom,
  undoStackAtom,
  suppressInputFocusAtom,
  type UndoItem,
} from "../agents/atoms"
import {
  selectedTeamIdAtom,
  isDesktopAtom,
  isFullscreenAtom,
  defaultAgentModeAtom,
} from "../../lib/atoms"
import { trpc } from "../../lib/trpc"
import { appStore } from "../../lib/jotai-store"
import { useWorkspaceChatsStore, type WorkspaceChat } from "../agents/stores/workspace-chats-store"
import { useAgentConversationStore } from "../agents/stores/conversation-store"
import { useShallow } from "zustand/react/shallow"
import {
  PlusIcon,
  ArchiveIcon,
  IconDoubleChevronLeft,
  IconSpinner,
  LoadingDot,
  PlanIcon,
  AgentIcon,
  IconOpenSidebar,
  ClockIcon,
  QuestionIcon,
} from "../../components/ui/icons"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../../components/ui/tooltip"
import { Kbd } from "../../components/ui/kbd"
import { isDesktopApp, getShortcutKey } from "../../lib/utils/platform"
import { useResolvedHotkeyDisplay } from "../../lib/hotkeys"
import { TrafficLightSpacer } from "../agents/components/traffic-light-spacer"
import { PopoverTrigger } from "../../components/ui/popover"
import { AlignJustify } from "lucide-react"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "../../components/ui/context-menu"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../components/ui/alert-dialog"
import { api } from "../../lib/api-adapter"
import { toast } from "sonner"
import { SearchCombobox } from "../../components/ui/search-combobox"
import { formatTimeAgo } from "../../lib/utils/format-time-ago"
import { pluralize } from "../../lib/utils/pluralize"
import { useHotkeys } from "react-hotkeys-hook"
import { Checkbox } from "../../components/ui/checkbox"
import { TypewriterText } from "../../components/ui/typewriter-text"
import { getCoreAgentIcon } from "../agents/components/core-agent-selector"

interface WorkspaceChatsSidebarProps {
  workspaceId: string | null
  workspaceName: string | null
  agentName: string | null
  onNewChatClick: () => void
  onChatSelect: (chatId: string) => void
}
// Memoized chat item component for better performance
const ChatItem = memo(function ChatItem({
  chat,
  isActive,
  isPinned,
  isJustCreated,
  hasPendingQuestion,
  onChatClick,
  onPinChat,
  onArchiveChat,
  chatNameRefs,
}: {
  chat: WorkspaceChat
  isActive: boolean
  isPinned: boolean
  isJustCreated: boolean
  hasPendingQuestion: boolean
  onChatClick: (chatId: string) => void
  onPinChat: (chatId: string) => void
  onArchiveChat: (chatId: string) => void
  chatNameRefs: React.MutableRefObject<Map<string, HTMLSpanElement>>
}) {
  return (
    <div
      className={cn(
        "group relative flex items-center gap-2 rounded-md px-2 py-1.5 text-sm cursor-pointer transition-colors",
        isActive
          ? "bg-accent text-accent-foreground"
          : "hover:bg-accent/50 text-muted-foreground"
      )}
      onClick={() => onChatClick(chat.id)}
    >
      {/* Pin indicator */}
      {isPinned && (
        <div className="flex-shrink-0 text-xs text-muted-foreground">📌</div>
      )}

      {/* Chat name */}
      <div className="flex-1 truncate">
        <span
          ref={(el) => {
            if (el) chatNameRefs.current.set(chat.id, el)
          }}
          className="truncate"
        >
          {chat.name || "New Chat"}
        </span>
      </div>

      {/* Just created indicator */}
      {isJustCreated && (
        <div className="flex-shrink-0">
          <LoadingDot isLoading={true} />
        </div>
      )}

      {/* Pending question indicator */}
      {hasPendingQuestion && (
        <div className="flex-shrink-0">
          <QuestionIcon className="h-3 w-3 text-orange-500" />
        </div>
      )}

      {/* Timestamp */}
      <div className="flex-shrink-0 text-xs text-muted-foreground">
        {formatTimeAgo(chat.updatedAt)}
      </div>

      {/* Actions (visible on hover) */}
      <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0"
          onClick={(e) => {
            e.stopPropagation()
            onPinChat(chat.id)
          }}
        >
          <span className="sr-only">{isPinned ? "Unpin" : "Pin"}</span>
          📌
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0"
          onClick={(e) => {
            e.stopPropagation()
            onArchiveChat(chat.id)
          }}
        >
          <ArchiveIcon className="h-3 w-3" />
          <span className="sr-only">Archive</span>
        </Button>
      </div>
    </div>
  )
})

/**
 * WorkspaceChatsSidebar - Displays all chats in the workspace
 * This replaces the old agents-conversations-sidebar which incorrectly showed conversations (tabs)
 */
export const WorkspaceChatsSidebar = memo(function WorkspaceChatsSidebar({
  workspaceId,
  workspaceName,
  agentName,
  onNewChatClick,
  onChatSelect,
}: WorkspaceChatsSidebarProps) {
  // Use the new workspace-level store
  const {
    chats,
    activeChatId,
    pinnedChatIds,
    sortBy,
    filterQuery,
    setActiveChat,
    togglePinChat,
    setSortBy,
    setFilterQuery,
  } = useWorkspaceChatsStore(
    useShallow((state) => ({
      chats: state.chats,
      activeChatId: state.activeChatId,
      pinnedChatIds: state.pinnedChatIds,
      sortBy: state.sortBy,
      filterQuery: state.filterQuery,
      setActiveChat: state.setActiveChat,
      togglePinChat: state.togglePinChat,
      setSortBy: state.setSortBy,
      setFilterQuery: state.setFilterQuery,
    }))
  )

  const selectedTeamId = useAtomValue(selectedTeamIdAtom)
  const [selectedChatId, setSelectedChatId] = useAtom(selectedAgentChatIdAtom)
  const previousChatId = useAtomValue(previousAgentChatIdAtom)
  const utils = trpc.useUtils()

  // Chat name tooltip - using refs instead of state to avoid re-renders on hover
  const chatNameRefs = useRef<Map<string, HTMLSpanElement>>(new Map())
  const chatTooltipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)

  // Archive chat mutation
  const archiveChatMutation = trpc.chats.archive.useMutation({
    onSuccess: (_, variables) => {
      // Hide tooltip if visible
      if (chatTooltipTimerRef.current) {
        clearTimeout(chatTooltipTimerRef.current)
        chatTooltipTimerRef.current = null
      }
      if (tooltipRef.current) {
        tooltipRef.current.style.display = "none"
      }

      utils.chats.list.invalidate()
      void utils.ergatai.workspaceStatus.invalidate()
      utils.chats.listArchived.invalidate()

      // Navigate to previous chat or new workspace
      if (selectedChatId === variables.id) {
        const isPreviousAvailable = previousChatId && previousChatId !== variables.id
        if (isPreviousAvailable) {
          setSelectedChatId(previousChatId)
          setActiveChat(previousChatId)
        } else {
          setSelectedChatId(null)
          setActiveChat(null)
        }
      }
    },
  })

  const setConversationUnseenChanges = useSetAtom(agentsConversationUnseenChangesAtom)

  // Resolved hotkey for tooltip
  const newAgentHotkey = useResolvedHotkeyDisplay("new-agent")
  const [justCreatedIds, setJustCreatedIds] = useAtom(justCreatedIdsAtom)
  const pendingQuestionsMap = useAtomValue(pendingUserQuestionsAtom)
  const rawMode = useAtomValue(defaultAgentModeAtom)
  const defaultAgentMode = rawMode === "plan" ? "plan" : "agent"

  // Undo stack
  const [undoStack, setUndoStack] = useAtom(undoStackAtom)

  // Debounced search query (300ms delay)
  const [debouncedFilterQuery, setDebouncedFilterQuery] = useState(filterQuery)

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedFilterQuery(filterQuery)
    }, 300)
    return () => clearTimeout(timer)
  }, [filterQuery])

  // Filter and sort chats
  const filteredChats = useMemo(() => {
    const filtered = chats.filter((chat) => !chat.archivedAt)

    // Apply search filter (using debounced query)
    const searched = debouncedFilterQuery
      ? filtered.filter((chat) =>
          chat.name?.toLowerCase().includes(debouncedFilterQuery.toLowerCase())
        )
      : filtered

    // Apply sorting (create new array to avoid mutation)
    return [...searched].sort((a, b) => {
      if (sortBy === "updatedAt") {
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      }
      if (sortBy === "createdAt") {
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      }
      return (a.name || "").localeCompare(b.name || "")
    })
  }, [chats, debouncedFilterQuery, sortBy])

  // Separate pinned and unpinned chats
  const pinnedChats = useMemo(
    () => filteredChats.filter((chat) => pinnedChatIds.includes(chat.id)),
    [filteredChats, pinnedChatIds]
  )
  const unpinnedChats = useMemo(
    () => filteredChats.filter((chat) => !pinnedChatIds.includes(chat.id)),
    [filteredChats, pinnedChatIds]
  )

  // Handle chat click
  const handleChatClick = useCallback(
    (chatId: string) => {
      // 1. Update workspace-level store
      setActiveChat(chatId)

      // 2. Sync to atom (backward compatibility)
      setSelectedChatId(chatId)

      // 3. Initialize conversation store for this chat
      useAgentConversationStore.getState().setChatId(chatId)

      // 4. Clear unseen indicator
      setConversationUnseenChanges((prev) => {
        const next = new Set(prev)
        next.delete(chatId)
        return next
      })

      // 5. Call parent callback
      onChatSelect(chatId)
    },
    [setActiveChat, setSelectedChatId, setConversationUnseenChanges, onChatSelect]
  )

  // Handle archive chat
  const handleArchiveChat = useCallback(
    (chatId: string) => {
      archiveChatMutation.mutate({ id: chatId })

      // Add to undo stack
      const timeoutId = setTimeout(() => {
        setUndoStack((prev) => prev.filter((item) => item.type !== "chat" || item.chatId !== chatId))
      }, 10000)

      setUndoStack((prev) => [
        ...prev,
        {
          type: "chat" as const,
          chatId,
          timeoutId,
        },
      ])
    },
    [archiveChatMutation, setUndoStack]
  )

  // Handle undo archive
  const handleUndoArchive = useCallback(
    (chatId: string) => {
      const undoItem = undoStack.find((item) => item.type === "chat" && item.chatId === chatId)
      if (undoItem && "timeoutId" in undoItem) {
        clearTimeout(undoItem.timeoutId)
      }

      // TODO: Implement unarchive endpoint in backend
      // For now, just remove from undo stack and refetch chats
      // utils.chats.unarchive.mutate({ id: chatId })
      setUndoStack((prev) => prev.filter((item) => item.type !== "chat" || item.chatId !== chatId))

      // Refetch chats to restore the archived chat
      utils.chats.list.invalidate()
    },
    [undoStack, utils.chats.list, setUndoStack]
  )

  // Handle pin chat
  const handlePinChat = useCallback(
    (chatId: string) => {
      togglePinChat(chatId)
    },
    [togglePinChat]
  )

  // Render chat item using memoized component
  const renderChatItem = useCallback(
    (chat: WorkspaceChat) => {
      const isActive = chat.id === activeChatId
      const isPinned = pinnedChatIds.includes(chat.id)
      const isJustCreated = justCreatedIds.has(chat.id)
      const hasPendingQuestion = pendingQuestionsMap.has(chat.id)
      return (
        <ChatItem
          key={chat.id}
          chat={chat}
          isActive={isActive}
          isPinned={isPinned}
          isJustCreated={isJustCreated}
          hasPendingQuestion={hasPendingQuestion}
          onChatClick={handleChatClick}
          onPinChat={handlePinChat}
          onArchiveChat={handleArchiveChat}
          chatNameRefs={chatNameRefs}
        />
      )
    },
    [activeChatId, pinnedChatIds, justCreatedIds, pendingQuestionsMap, handleChatClick, handlePinChat, handleArchiveChat]
  )

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-3 py-2">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">Chats</h2>
          {workspaceName && (
            <span className="text-xs text-muted-foreground">({workspaceName})</span>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={onNewChatClick}
          title="New Chat"
        >
          <PlusIcon className="h-4 w-4" />
          <span className="sr-only">New Chat</span>
        </Button>
      </div>

      {/* Search and filters */}
      <div className="border-b px-3 py-2">
        <Input
          placeholder="Search chats..."
          value={filterQuery}
          onChange={(e) => setFilterQuery(e.target.value)}
          className="h-8 text-sm"
        />
        <div className="mt-2 flex items-center gap-2">
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as "updatedAt" | "createdAt" | "name")}
            className="h-7 rounded border bg-background px-2 text-xs"
          >
            <option value="updatedAt">Last updated</option>
            <option value="createdAt">Created date</option>
            <option value="name">Name</option>
          </select>
        </div>
      </div>

      {/* Chat list */}
      <div className="flex-1 overflow-y-auto">
        {filteredChats.length === 0 ? (
          <div className="flex h-full items-center justify-center p-4 text-center text-sm text-muted-foreground">
            {filterQuery ? "No chats match your search" : "No chats yet. Create one to get started!"}
          </div>
        ) : (
          <div className="space-y-1 p-2">
            {/* Pinned chats */}
            {pinnedChats.length > 0 && (
              <div className="space-y-1">
                <div className="px-2 py-1 text-xs font-semibold text-muted-foreground">
                  Pinned
                </div>
                {pinnedChats.map(renderChatItem)}
              </div>
            )}

            {/* Unpinned chats */}
            {unpinnedChats.length > 0 && (
              <div className="space-y-1">
                {pinnedChats.length > 0 && (
                  <div className="px-2 py-1 text-xs font-semibold text-muted-foreground">
                    All Chats
                  </div>
                )}
                {unpinnedChats.map(renderChatItem)}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Undo toast */}
      <AnimatePresence>
        {undoStack
          .filter((item) => item.type === "chat")
          .map((item) => (
            <motion.div
              key={item.chatId}
              initial={{ opacity: 0, y: 50 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 50 }}
              className="fixed bottom-4 right-4 z-50"
            >
              <div className="rounded-lg bg-popover p-4 shadow-lg border">
                <p className="text-sm">Chat archived</p>
                <Button
                  variant="link"
                  size="sm"
                  onClick={() => handleUndoArchive(item.chatId)}
                >
                  Undo
                </Button>
              </div>
            </motion.div>
          ))}
      </AnimatePresence>
    </div>
  )
})
