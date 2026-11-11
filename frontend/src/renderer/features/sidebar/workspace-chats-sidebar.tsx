"use client"

import React, { useMemo, useState, useCallback, useRef, useEffect, memo } from "react"
import { useAtom, useAtomValue, useSetAtom } from "jotai"
// react-doctor-disable-next-line use-lazy-motion
import { motion, AnimatePresence } from "motion/react"
import { Button } from "../../components/ui/button"
import { Input } from "../../components/ui/input"
import { cn } from "../../lib/utils"
import {
  agentsConversationUnseenChangesAtom,
  selectedAgentChatIdAtom,
  previousAgentChatIdAtom,
  conversationFilesAtom,
  justCreatedIdsAtom,
  pendingUserQuestionsAtom,
  undoStackAtom,
} from "../agents"
import {
  isDesktopAtom,
  isFullscreenAtom,
  defaultAgentModeAtom,
} from "../../lib/atoms"
import { trpc } from "../../lib/trpc"
import { useWorkspaceChatsStore, type WorkspaceChat } from "../agents"
import { useAgentConversationStore } from "../agents"
import { useShallow } from "zustand/react/shallow"
import {
  IconDoubleChevronLeft,
  LoadingDot,
  PlanIcon,
  AgentIcon,
  QuestionIcon,
} from "../../components/ui/icons"
import { getCoreAgentIcon } from "../agents"
import { chatAgentLogosAtom, type ChatAgentLogo } from "../agents"
import type { CoreAgentId } from "../agents/public"
import { AlignJustify } from "lucide-react"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../../components/ui/tooltip"
import { Kbd } from "../../components/ui/kbd"
import { useResolvedHotkeyDisplay } from "../../lib/hotkeys"
import { TrafficLightSpacer } from "../agents"
import {
  ContextMenu,
  ContextMenuTrigger,
} from "../../components/ui/context-menu"
import { formatTimeAgo } from "../../lib/utils/format-time-ago"
import { useConversationDraftsCache, getConversationDraftKey } from "../agents"
import { TypewriterText } from "../../components/ui/typewriter-text"
import { ConversationDropdownMenu } from "../agents"

interface FileChange {
  additions: number
  deletions: number
}

interface FileStats {
  fileCount: number
  additions: number
  deletions: number
}

interface ChatSectionProps {
  title: string
  items: WorkspaceChat[]
  startIndex: number
  bottomMargin?: boolean
  renderChatItem: (chat: WorkspaceChat, index: number) => React.ReactNode
}

function ChatSection({ title, items, startIndex, bottomMargin, renderChatItem }: ChatSectionProps) {
  return (
    <>
      <div className="flex items-center h-4 mb-1 pl-2">
        <h3 className="text-xs font-medium text-muted-foreground whitespace-nowrap">
          {title}
        </h3>
      </div>
      {items.length > 0 && (
        <div className={cn("list-none p-0 m-0", bottomMargin && "mb-3")}>
          {items.map((chat, idx) => renderChatItem(chat, startIndex + idx))}
        </div>
      )}
    </>
  )
}

interface WorkspaceChatsSidebarProps {
  onClose?: () => void
  onBackToChats?: () => void
  isSidebarOpen?: boolean
  workspaceId: string | null
  workspaceName: string | null
  agentName: string | null
  onNewChatClick: () => void
  onChatSelect: (chatId: string) => void
}

// Memoized chat item component with restored styles from old sidebar
// react-doctor-disable-next-line no-high-complexity-react-function
const ChatItem = memo(function ChatItem({
  chat,
  isActive,
  isPinned,
  isJustCreated,
  hasPendingQuestion,
  hasUnseen,
  isLoading,
  mode,
  draftText,
  fileChanges,
  onChatClick,
  onPinChat,
  onArchiveChat,
  chatNameRefs,
  globalIndex,
  totalCount,
  agentLogos,
}: {
  chat: WorkspaceChat
  isActive: boolean
  isPinned: boolean
  isJustCreated: boolean
  hasPendingQuestion: boolean
  hasUnseen: boolean
  isLoading: boolean
  mode: string
  draftText: string | null
  fileChanges: FileChange[]
  onChatClick: (chatId: string) => void
  onPinChat: (chatId: string) => void
  onArchiveChat: (chatId: string) => void
  chatNameRefs: React.MutableRefObject<Map<string, HTMLSpanElement>>
  globalIndex: number
  totalCount: number
  agentLogos?: ChatAgentLogo[]
}) {
  // Calculate file stats
  const stats = useMemo<FileStats | null>(() => {
    if (fileChanges.length === 0) return null
    return fileChanges.reduce<FileStats>(
      (acc, f) => ({
        fileCount: acc.fileCount + 1,
        additions: acc.additions + f.additions,
        deletions: acc.deletions + f.deletions,
      }),
      { fileCount: 0, additions: 0, deletions: 0 }
    )
  }, [fileChanges])

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="button"
          data-testid={`chat-item-${chat.id}`}
          data-conversation-index={globalIndex}
          onClick={() => onChatClick(chat.id)}
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault()
              onChatClick(chat.id)
            }
          }}
          className={cn(
            "w-full text-left py-1.5 transition-colors duration-75 cursor-pointer group relative",
            "outline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring/70",
            "pl-2 pr-2 rounded-md",
            isActive
              ? "bg-foreground/5 text-foreground"
              : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
          )}
        >
          <div className="flex items-start gap-2.5">
            {/* Icon container with status badge */}
            <div className="pt-0.5 flex-shrink-0 w-4 h-4 flex items-center justify-center relative">
              {/* Mode icon or Question icon or Agent logo */}
              <div className="transition-[opacity,transform] duration-150 ease-out">
                {hasPendingQuestion ? (
                  <QuestionIcon className="w-4 h-4 text-blue-500" />
                ) : mode === "plan" ? (
                  <PlanIcon className="w-4 h-4 text-muted-foreground" />
                ) : agentLogos && agentLogos.length > 0 ? (
                  (() => {
                    // Use the first agent's logo
                    const logo = agentLogos[0]
                    const Icon = getCoreAgentIcon(logo.agentId as CoreAgentId)
                    return <Icon className="w-4 h-4 text-muted-foreground" />
                  })()
                ) : (
                  <AgentIcon className="w-4 h-4 text-muted-foreground" />
                )}
              </div>
              {/* Status badge in bottom-right corner */}
              {(isLoading || hasUnseen) && !hasPendingQuestion && (
                <div
                  className={cn(
                    "absolute -bottom-1 -right-1 w-3 h-3 rounded-full flex items-center justify-center",
                    isActive
                      ? "bg-[#E8E8E8] dark:bg-[#1B1B1B]"
                      : "bg-[#F4F4F4] group-hover:bg-[#E8E8E8] dark:bg-[#101010] dark:group-hover:bg-[#1B1B1B]"
                  )}
                >
                  {isLoading ? (
                    <LoadingDot isLoading={true} className="w-2.5 h-2.5 text-muted-foreground" />
                  ) : (
                    <LoadingDot isLoading={false} className="w-2.5 h-2.5 text-muted-foreground" />
                  )}
                </div>
              )}
            </div>
            {/* Content area */}
            <div className="flex-1 min-w-0 flex flex-col gap-0.5">
              <div className="flex items-center gap-1">
                <span
                  ref={(el) => {
                    if (el) chatNameRefs.current.set(chat.id, el)
                  }}
                  className="truncate block text-sm leading-tight flex-1"
                >
                  <TypewriterText
                    text={chat.name || ""}
                    placeholder="New Chat"
                    id={chat.id}
                    isJustCreated={isJustCreated}
                    showPlaceholder={true}
                  />
                </span>
                <ConversationDropdownMenu
                  conversation={{
                    id: chat.id,
                    name: chat.name || "New Chat",
                    created_at: chat.createdAt?.toISOString(),
                    updated_at: chat.updatedAt?.toISOString(),
                  }}
                  isPinned={isPinned}
                  onTogglePin={onPinChat}
                  onRename={() => {}} // Not supported in workspace chats sidebar
                  onArchive={onArchiveChat}
                  onArchiveOthers={() => {}} // Not supported in workspace chats sidebar
                  isOnlyChat={totalCount === 1}
                  currentIndex={globalIndex}
                  totalCount={totalCount}
                  chatId={chat.id}
                  isActiveTab={isActive}
                  isSplitTab={false}
                />
              </div>
              {/* Second line: draft or file stats + timestamp */}
              <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground/60 min-w-0">
                {draftText ? (
                  <span className="truncate flex-1 min-w-0">
                    <span className="text-blue-500">Draft:</span> {draftText}
                  </span>
                ) : (
                  <span className="truncate flex-1 min-w-0">
                    {stats ? (
                      <>
                        {stats.fileCount} {stats.fileCount === 1 ? "file" : "files"}
                      </>
                    ) : null}
                  </span>
                )}
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  {!draftText && stats && (stats.additions > 0 || stats.deletions > 0) && (
                    <>
                      <span className="text-green-600 dark:text-green-400">+{stats.additions}</span>
                      <span className="text-red-600 dark:text-red-400">-{stats.deletions}</span>
                    </>
                  )}
                  <span>{formatTimeAgo(chat.updatedAt)}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </ContextMenuTrigger>
    </ContextMenu>
  )
})

/**
 * WorkspaceChatsSidebar - Displays all chats in the workspace
 * This replaces the old agents-conversations-sidebar which incorrectly showed conversations (tabs)
 */
// react-doctor-disable-next-line no-giant-component
export const WorkspaceChatsSidebar = memo(function WorkspaceChatsSidebar({
  onClose,
  onBackToChats,
  isSidebarOpen = false,
  workspaceId,
  workspaceName: _workspaceName,
  agentName: _agentName,
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
    setSortBy: _setSortBy,
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

  const [selectedChatId, setSelectedChatId] = useAtom(selectedAgentChatIdAtom)
  const previousChatId = useAtomValue(previousAgentChatIdAtom)
  const utils = trpc.useUtils()
  const chatAgentLogos = useAtomValue(chatAgentLogosAtom)

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
      if (variables && 'id' in variables && selectedChatId === variables.id) {
        const chatId = variables.id
        const isPreviousAvailable = previousChatId && previousChatId !== chatId
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

  // File changes and drafts for stats display
  const conversationFiles = useAtomValue(conversationFilesAtom)
  const draftsCache = useConversationDraftsCache()

  // Resolved hotkey for tooltip
  const newAgentHotkey = useResolvedHotkeyDisplay("new-agent")
  const [justCreatedIds, _setJustCreatedIds] = useAtom(justCreatedIdsAtom)
  const pendingQuestionsMap = useAtomValue(pendingUserQuestionsAtom)
  const unseenChanges = useAtomValue(agentsConversationUnseenChangesAtom)
  const rawMode = useAtomValue(defaultAgentModeAtom)
  const defaultAgentMode = rawMode === "plan" ? "plan" : "agent"
  const isDesktop = useAtomValue(isDesktopAtom)
  const isFullscreen = useAtomValue(isFullscreenAtom)

  // Gradient state for scroll indicators
  const [showTopGradient, setShowTopGradient] = useState(false)
  const [showBottomGradient, setShowBottomGradient] = useState(true)
  const scrollContainerRef = useRef<HTMLDivElement>(null)

  // Update gradients based on scroll position
  const updateGradients = useCallback(() => {
    const container = scrollContainerRef.current
    if (!container) return

    const { scrollTop, scrollHeight, clientHeight } = container
    setShowTopGradient(scrollTop > 0)
    setShowBottomGradient(scrollTop + clientHeight < scrollHeight - 1)
  }, [])

  // Observe scroll container for gradient updates
  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container) return

    updateGradients()

    const observer = new ResizeObserver(updateGradients)
    observer.observe(container)

    return () => observer.disconnect()
  }, [updateGradients])

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
    // react-doctor-disable-next-line js-set-map-lookups
    () => filteredChats.filter((chat) => pinnedChatIds.includes(chat.id)),
    [filteredChats, pinnedChatIds]
  )
  const unpinnedChats = useMemo(
    // react-doctor-disable-next-line js-set-map-lookups
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
    (chat: WorkspaceChat, index: number) => {
      const isActive = chat.id === activeChatId
      const isPinned = pinnedChatIds.includes(chat.id)
      const isJustCreated = justCreatedIds.has(chat.id)
      const hasPendingQuestion = pendingQuestionsMap.has(chat.id)
      const hasUnseen = unseenChanges.has(chat.id)
      const isLoading = false // Workspace chats don't have loading state per chat
      const mode = defaultAgentMode

      // Get draft text for this chat
      const draftKey = workspaceId ? getConversationDraftKey(workspaceId, chat.id) : null
      const draftText: string | null = draftKey ? (draftsCache[draftKey] as string) || null : null

      // Get file changes for this chat
      const fileChanges = conversationFiles.get(chat.id) || []

      // Get agent logos for this chat
      const agentLogos = chatAgentLogos[chat.id]

      return (
        <ChatItem
          key={chat.id}
          chat={chat}
          isActive={isActive}
          isPinned={isPinned}
          isJustCreated={isJustCreated}
          hasPendingQuestion={hasPendingQuestion}
          hasUnseen={hasUnseen}
          isLoading={isLoading}
          mode={mode}
          draftText={draftText}
          fileChanges={fileChanges}
          onChatClick={handleChatClick}
          onPinChat={handlePinChat}
          onArchiveChat={handleArchiveChat}
          chatNameRefs={chatNameRefs}
          globalIndex={index}
          totalCount={filteredChats.length}
          agentLogos={agentLogos}
        />
      )
    },
    [activeChatId, pinnedChatIds, justCreatedIds, pendingQuestionsMap, unseenChanges, defaultAgentMode, draftsCache, workspaceId, conversationFiles, handleChatClick, handlePinChat, handleArchiveChat, filteredChats.length, chatAgentLogos]
  )

  return (
    <div
      data-testid="conversation-sidebar"
      className="flex flex-col h-full bg-background border-r overflow-hidden relative"
      style={{ borderRightWidth: "0.5px" }}
    >
      {/* Draggable area for window movement */}
      {isDesktop && !isFullscreen && (
        <div
          className="absolute inset-0 z-0"
          style={{
            WebkitAppRegion: "drag",
          } as React.CSSProperties}
        />
      )}

      {/* Spacer for macOS traffic lights */}
      <TrafficLightSpacer isDesktop={isDesktop} isFullscreen={isFullscreen} />

      {/* Header buttons - positioned at top left and right */}
      {/* Open agents sidebar button - shown when agents sidebar is closed */}
      {!isSidebarOpen && onBackToChats && (
        <div
          className="absolute left-2 top-2 z-20"
          style={{
            WebkitAppRegion: "no-drag",
          } as React.CSSProperties}
        >
          <Tooltip delayDuration={500}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={onBackToChats}
                tabIndex={-1}
                className="h-6 w-6 p-0 hover:bg-foreground/10 transition-[background-color,transform] duration-150 ease-out active:scale-[0.97] text-foreground flex-shrink-0 rounded-md"
                aria-label="Toggle agents sidebar"
              >
                <AlignJustify className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Open chats sidebar</TooltipContent>
          </Tooltip>
        </div>
      )}

      {/* Close chats sidebar button - right side */}
      {onClose && (
        <div
          className="absolute right-2 top-2 z-20"
          style={{
            WebkitAppRegion: "no-drag",
          } as React.CSSProperties}
        >
          <Tooltip delayDuration={500}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={onClose}
                tabIndex={-1}
                className="h-6 w-6 p-0 hover:bg-foreground/10 transition-[background-color,transform] duration-150 ease-out active:scale-[0.97] text-foreground flex-shrink-0 rounded-md"
                aria-label="Close sidebar"
              >
                <IconDoubleChevronLeft className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Close chats pane</TooltipContent>
          </Tooltip>
        </div>
      )}

      {/* Header */}
      <div className="p-2 pb-3 flex-shrink-0 relative z-10">
        <div className="space-y-2">
          {/* Spacer for buttons area - always show to maintain consistent layout */}
          <div className="h-6" />

          {/* Search input */}
          <div
            className="relative"
            style={{
              WebkitAppRegion: "no-drag",
            } as React.CSSProperties}
          >
            <Input
              placeholder="Search chats..."
              value={filterQuery}
              onChange={(e) => setFilterQuery(e.target.value)}
              className="h-7 w-full rounded-lg text-sm bg-muted border border-input placeholder:text-muted-foreground/40"
            />
          </div>
          {/* New Chat Button */}
          <div
            style={{
              WebkitAppRegion: "no-drag",
            } as React.CSSProperties}
          >
            <Tooltip delayDuration={500}>
              <TooltipTrigger asChild>
                <Button
                  data-testid="new-conversation-button"
                  onClick={() => onNewChatClick?.()}
                  disabled={!workspaceId}
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 w-full hover:bg-foreground/10 transition-[background-color,transform] duration-150 ease-out active:scale-[0.97] text-foreground rounded-lg"
                >
                  <span className="text-sm font-medium">New Chat</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">
                Create new chat
                {newAgentHotkey && <Kbd>{newAgentHotkey}</Kbd>}
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
      </div>

      {/* Scrollable chat list with gradients */}
      <div
        className="flex-1 min-h-0 relative z-10"
        style={{
          WebkitAppRegion: "no-drag",
        } as React.CSSProperties}
      >
        <div className="relative h-full">
          {/* Top gradient */}
          {showTopGradient && (
            <div className="absolute left-0 right-0 top-0 h-8 bg-gradient-to-b from-background to-transparent pointer-events-none z-10" />
          )}

          {/* Bottom gradient */}
          {showBottomGradient && (
            <div className="absolute left-0 right-0 bottom-0 h-8 bg-gradient-to-t from-background to-transparent pointer-events-none z-10" />
          )}

          <div
            data-sidebar-scroll
            ref={scrollContainerRef}
            onScroll={updateGradients}
            className="h-full overflow-y-auto scrollbar-thin scrollbar-thumb-muted-foreground/20 scrollbar-track-transparent px-2"
          >
            <div className="mb-4 -mx-1">
              {pinnedChats.length > 0 && (
                <ChatSection
                  title="Pinned Chats"
                  items={pinnedChats}
                  startIndex={0}
                  bottomMargin
                  renderChatItem={renderChatItem}
                />
              )}
              <ChatSection
                title="Chats"
                items={unpinnedChats}
                startIndex={pinnedChats.length}
                renderChatItem={renderChatItem}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Undo toast */}
      <AnimatePresence>
        {undoStack
          .filter((item) => item.type === "chat")
          .map((item) => (
            <motion.div
              key={item.chatId}
              initial={{ opacity: 0, transform: "translateY(50px)" }}
              animate={{ opacity: 1, transform: "translateY(0px)" }}
              exit={{ opacity: 0, transform: "translateY(50px)" }}
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
