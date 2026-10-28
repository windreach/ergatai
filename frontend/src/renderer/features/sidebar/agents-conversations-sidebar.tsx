"use client"

import React, { useMemo, useState, useCallback, useRef, useEffect, memo } from "react"
import { createPortal } from "react-dom"
import { useAtom, useAtomValue, useSetAtom } from "jotai"
import { motion, AnimatePresence } from "motion/react"
import { Button } from "../../components/ui/button"
import { Input } from "../../components/ui/input"
import { cn } from "../../lib/utils"
import {
  loadingConversationsAtom,
  agentsConversationUnseenChangesAtom,
  selectedAgentChatIdAtom,
  previousAgentChatIdAtom,
  conversationFilesAtom,
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
  selectedConversationIdsAtom,
  isConversationMultiSelectModeAtom,
  toggleConversationSelectionAtom,
  selectAllConversationsAtom,
  clearConversationSelectionAtom,
  selectedConversationsCountAtom,
  isDesktopAtom,
  isFullscreenAtom,
  defaultAgentModeAtom,
} from "../../lib/atoms"
import { trpc } from "../../lib/trpc"
import { appStore } from "../../lib/jotai-store"
import {
  useAgentConversationStore,
  type ConversationMeta,
} from "../agents/stores/conversation-store"
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
import { AgentsRenameConversationDialog } from "../agents/components/agents-rename-conversation-dialog"
import { SearchCombobox } from "../../components/ui/search-combobox"
import { ConversationContextMenu } from "../agents/ui/conversation-context-menu"
import { ConversationDropdownMenu } from "../agents/ui/conversation-dropdown-menu"
import { formatTimeAgo } from "../../lib/utils/format-time-ago"
import { pluralize } from "../../lib/utils/pluralize"
import { useHotkeys } from "react-hotkeys-hook"
import { useConversationDraftsCache, getConversationDraftKey } from "../agents/lib/drafts"
import { Checkbox } from "../../components/ui/checkbox"
import { TypewriterText } from "../../components/ui/typewriter-text"
import { getCoreAgentIcon } from "../agents/components/core-agent-selector"
import {
  hasStoredGroupAgentIds,
  loadGroupAgentIds,
  loadGroupAgents,
} from "../agents/collaboration/group-agent-storage"
import { useCollaborationMode } from "../agents/collaboration/use-collaboration-mode"
import type { inferRouterOutputs } from "@trpc/server"
import type { AppRouter } from "../../../main/lib/trpc/routers"

type RouterOutput = inferRouterOutputs<AppRouter>

// Isolated Search History Popover for sidebar - prevents parent re-renders when popover opens/closes
interface SidebarSearchHistoryPopoverProps {
  sortedConversations: ConversationMeta[]
  loadingConversations: Map<string, string>
  conversationsUnseenChanges: Set<string>
  pendingQuestionsMap: Map<string, { conversationId: string }>
  allConversationsLength: number
  onSelect: (conversation?: ConversationMeta) => void
}

function displayText(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback
}

const WorkspaceChatList = memo(function WorkspaceChatList({
  workspaceId,
  searchQuery,
  selectedChatId,
  onChatSelect,
}: {
  workspaceId?: string | null
  searchQuery?: string
  selectedChatId?: string | null
  onChatSelect?: (chatId: string) => void
}) {
  const { data: chats, isLoading } = trpc.chats.list.useQuery(
    {
      workspaceId: workspaceId!,
    },
    { enabled: !!workspaceId },
  )

  const workspaceChats = useMemo(() => {
    const query = searchQuery?.trim().toLowerCase() ?? ""
    return (chats ?? [])
      .filter((chat) => (
        chat.id.startsWith("chat_") &&
        (!query || `${chat.name || "New Chat"}`.toLowerCase().includes(query))
      ))
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
  }, [chats, searchQuery])

  if (!workspaceId) {
    return null
  }

  return (
    <div className={cn("mb-4", "px-0")}>
      <div className="flex items-center h-4 mb-1 pl-2">
        <h3 className="text-xs font-medium text-muted-foreground whitespace-nowrap">
          Chats
        </h3>
      </div>

      {isLoading ? (
        <div className="px-2 py-2 text-xs text-muted-foreground">
          Loading chats...
        </div>
      ) : workspaceChats.length > 0 ? (
        <div className="list-none p-0 m-0 space-y-0.5">
          {workspaceChats.map((chat) => (
            <WorkspaceChatItem
              key={chat.id}
              chat={chat}
              isSelected={selectedChatId === chat.id}
              onChatSelect={onChatSelect}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
})

const WorkspaceChatItem = memo(function WorkspaceChatItem({
  chat,
  isSelected,
  onChatSelect,
}: {
  chat: RouterOutput["chats"]["list"][number]
  isSelected: boolean
  onChatSelect?: (chatId: string) => void
}) {
  const chatAgentLogosMap = useAtomValue(chatAgentLogosAtom)
  const registeredAgents = useAtomValue(registeredAgentsAtom)
  const chatAgentLogos = useMemo(() => {
    const storedLogos = chatAgentLogosMap[chat.id]
    if (storedLogos?.length) return storedLogos
    if (!hasStoredGroupAgentIds(chat.id)) return []

    return createChatAgentLogos(
      loadGroupAgentIds(chat.id),
      loadGroupAgents(chat.id),
      registeredAgents,
    )
  }, [chatAgentLogosMap, chat.id, registeredAgents])
  const visibleChatAgentLogos = chatAgentLogos.slice(0, MAX_CHAT_AGENT_LOGOS)

  return (
    <button
      type="button"
      onClick={() => onChatSelect?.(chat.id)}
      className={cn(
        "w-full rounded-lg px-2 text-left transition-colors",
        "py-2.5",
        isSelected
          ? "bg-foreground/10 text-foreground"
          : "text-foreground/80 hover:bg-foreground/5 hover:text-foreground",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm">
          {chat.name || "New Chat"}
        </span>
        <span className="flex flex-shrink-0 flex-col items-end gap-1">
          {visibleChatAgentLogos.length > 0 ? (
            <span className="flex items-center justify-end -space-x-1">
              {visibleChatAgentLogos.map((logo) => (
                <ChatAgentLogoBadge
                  key={`${logo.agentId}:${logo.avatarUrl ?? "core"}`}
                  logo={logo}
                />
              ))}
            </span>
          ) : (
            <AgentIcon className="h-3.5 w-3.5 text-muted-foreground/50" />
          )}
          <span className="text-[11px] text-muted-foreground/60">
            {formatTimeAgo(chat.updatedAt)}
          </span>
        </span>
      </div>
    </button>
  )
})

function ChatAgentLogoBadge({ logo }: { logo: ChatAgentLogo }) {
  const [avatarFailed, setAvatarFailed] = useState(false)
  const AgentLogo = getCoreAgentIcon(logo.agentId)

  return (
    <span
      title={logo.name}
      aria-label={logo.name}
      className="relative flex h-3.5 w-3.5 items-center justify-center rounded-sm bg-background"
    >
      {logo.avatarUrl && !avatarFailed ? (
        <img
          src={logo.avatarUrl}
          alt={logo.name}
          className="h-full w-full rounded-sm object-contain"
          onError={() => setAvatarFailed(true)}
        />
      ) : (
        <AgentLogo className="h-3 w-3 text-muted-foreground/50" />
      )}
    </span>
  )
}

const SidebarSearchHistoryPopover = memo(function SidebarSearchHistoryPopover({
  sortedConversations,
  loadingConversations,
  conversationsUnseenChanges,
  pendingQuestionsMap,
  allConversationsLength,
  onSelect,
}: SidebarSearchHistoryPopoverProps) {
  const [isHistoryOpen, setIsHistoryOpen] = useState(false)

  const handleSelect = useCallback((conversation?: ConversationMeta) => {
    onSelect(conversation)
    setIsHistoryOpen(false)
  }, [onSelect])

  const renderItem = useCallback((conversation?: ConversationMeta) => {
    const timeAgo = formatTimeAgo(conversation?.updated_at || conversation?.created_at)
    const isLoading = loadingConversations.has(conversation?.id || "")
    const hasUnseen = conversationsUnseenChanges.has(conversation?.id || "")
    const mode = conversation?.mode || "agent"
    const hasPendingQuestion = pendingQuestionsMap.has(conversation?.id || "")

    return (
      <div className="flex items-center gap-2 flex-1 min-w-0">
        <div className="flex-shrink-0 w-4 h-4 flex items-center justify-center relative">
          {hasPendingQuestion ? (
            <QuestionIcon className="w-4 h-4 text-blue-500" />
          ) : isLoading ? (
            <IconSpinner className="w-4 h-4 text-muted-foreground" />
          ) : mode === "plan" ? (
            <PlanIcon className="w-4 h-4 text-muted-foreground" />
          ) : (
            <AgentIcon className="w-4 h-4 text-muted-foreground" />
          )}
          {hasUnseen && !isLoading && !hasPendingQuestion && (
            <div className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-popover flex items-center justify-center">
              <div className="w-1.5 h-1.5 rounded-full bg-[#307BD0]" />
            </div>
          )}
        </div>
        <span className="text-sm truncate flex-1">
          {conversation?.name || "New Chat"}
        </span>
        <span className="text-sm text-muted-foreground whitespace-nowrap">
          {timeAgo}
        </span>
      </div>
    )
  }, [loadingConversations, conversationsUnseenChanges, pendingQuestionsMap])

  return (
    <SearchCombobox
      isOpen={isHistoryOpen}
      onOpenChange={setIsHistoryOpen}
      items={sortedConversations}
      onSelect={handleSelect}
      placeholder="Search chats..."
      emptyMessage="No results"
      getItemValue={(conversation) => `${conversation?.name || "New Chat"} ${conversation?.id}`}
      renderItem={renderItem}
      side="bottom"
      align="end"
      sideOffset={4}
      collisionPadding={16}
      trigger={
        <Tooltip delayDuration={500}>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 p-0 hover:bg-foreground/10 transition-[background-color,transform] duration-150 ease-out active:scale-[0.97] flex-shrink-0 rounded-md"
                disabled={allConversationsLength === 0}
              >
                <ClockIcon className="h-4 w-4" />
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">Conversation history</TooltipContent>
        </Tooltip>
      }
    />
  )
})

interface AgentsConversationsSidebarProps {
  onClose?: () => void
  isMobile?: boolean
  onBackToChats?: () => void
  isSidebarOpen?: boolean
  isLoading?: boolean
  workspaceId?: string | null
  workspaceName?: string | null
  agentName?: string
  onNewChatClick?: () => void
  onChatSelect?: (chatId: string) => void
}

export function AgentsConversationsSidebar({
  onClose,
  isMobile = false,
  onBackToChats,
  isSidebarOpen = false,
  isLoading = false,
  workspaceId,
  workspaceName,
  agentName,
  onNewChatClick,
  onChatSelect,
}: AgentsConversationsSidebarProps) {
  // Use shallow comparison to prevent re-renders when arrays have same content
  const {
    activeConversationId,
    openConversationIds,
    pinnedConversationIds,
    allConversations,
    parentChatId,
    togglePinConversation,
    splitPaneIds,
    addToSplit,
    removeFromSplit,
    closeSplit,
  } = useAgentConversationStore(
    useShallow((state) => ({
      activeConversationId: state.activeConversationId,
      openConversationIds: state.openConversationIds,
      pinnedConversationIds: state.pinnedConversationIds,
      allConversations: state.allConversations,
      parentChatId: state.chatId,
      togglePinConversation: state.togglePinConversation,
      splitPaneIds: state.splitPaneIds,
      addToSplit: state.addToSplit,
      removeFromSplit: state.removeFromSplit,
      closeSplit: state.closeSplit,
    }))
  )
  const [loadingConversations] = useAtom(loadingConversationsAtom)
  const conversationFiles = useAtomValue(conversationFilesAtom)
  const selectedTeamId = useAtomValue(selectedTeamIdAtom)
  const [selectedChatId, setSelectedChatId] = useAtom(selectedAgentChatIdAtom)
  const previousChatId = useAtomValue(previousAgentChatIdAtom)

  // Fetch agent chats for navigation after archive
  const { data: agentChats } = api.agents.getAgentChats.useQuery(
    { teamId: selectedTeamId! },
    { enabled: !!selectedTeamId },
  )

  const utils = trpc.useUtils()

  // Conversation name tooltip - using refs instead of state to avoid re-renders on hover
  // Declared here so they can be used in archive mutation's onSuccess
  const conversationNameRefs = useRef<Map<string, HTMLSpanElement>>(new Map())
  const conversationTooltipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)

  // Archive parent chat mutation
  const archiveChatMutation = trpc.chats.archive.useMutation({
    onSuccess: (_, variables) => {
      // Hide tooltip if visible (element may be removed from DOM before mouseLeave fires)
      if (conversationTooltipTimerRef.current) {
        clearTimeout(conversationTooltipTimerRef.current)
        conversationTooltipTimerRef.current = null
      }
      if (tooltipRef.current) {
        tooltipRef.current.style.display = "none"
      }

      utils.chats.list.invalidate()
      void utils.ergatai.workspaceStatus.invalidate()
      utils.chats.listArchived.invalidate()

      // Navigate to previous chat or new workspace
      if (selectedChatId === variables.id) {
        const isPreviousAvailable = previousChatId &&
          agentChats?.some((c) => c.id === previousChatId)

        if (isPreviousAvailable) {
          setSelectedChatId(previousChatId)
        } else {
          setSelectedChatId(null)
        }
      }
    },
  })
  const conversationsUnseenChanges = useAtomValue(agentsConversationUnseenChangesAtom)
  const setConversationUnseenChanges = useSetAtom(agentsConversationUnseenChangesAtom)

  // Resolved hotkey for tooltip
  const newAgentHotkey = useResolvedHotkeyDisplay("new-agent")
  const [justCreatedIds, setJustCreatedIds] = useAtom(justCreatedIdsAtom)
  const pendingQuestionsMap = useAtomValue(pendingUserQuestionsAtom)
  const rawMode = useAtomValue(defaultAgentModeAtom)
  const defaultAgentMode = rawMode === "plan" ? "plan" : "agent"

  // Pending plan approvals from DB - only for open conversations
  const { data: pendingPlanApprovalsData } = trpc.chats.getPendingPlanApprovals.useQuery(
    { openConversationIds },
    { refetchInterval: 5000, enabled: openConversationIds.length > 0, placeholderData: (prev) => prev }
  )
  const pendingPlanApprovals = useMemo(() => {
    const set = new Set<string>()
    if (pendingPlanApprovalsData) {
      for (const { conversationId } of pendingPlanApprovalsData) {
        set.add(conversationId)
      }
    }
    return set
  }, [pendingPlanApprovalsData])

  // Unified undo stack for Cmd+Z support
  const setUndoStack = useSetAtom(undoStackAtom)
  const [searchQuery, setSearchQuery] = useState("")
  const { config: collaborationModeConfig } = useCollaborationMode()
  const [focusedChatIndex, setFocusedChatIndex] = useState<number>(-1)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const [renameDialogOpen, setRenameDialogOpen] = useState(false)
  const [renamingConversation, setRenamingConversation] = useState<ConversationMeta | null>(
    null,
  )
  const [renameLoading, setRenameLoading] = useState(false)
  const [showTopGradient, setShowTopGradient] = useState(false)
  const [showBottomGradient, setShowBottomGradient] = useState(false)
  // Using ref instead of state to avoid re-renders on hover
  const hoveredChatIndexRef = useRef<number>(-1)
  const [archiveAgentDialogOpen, setArchiveAgentDialogOpen] = useState(false)
  const [conversationToArchive, setConversationToArchive] = useState<ConversationMeta | null>(
    null,
  )

  // Multi-select state
  const [selectedConversationIds, setSelectedConversationIds] = useAtom(
    selectedConversationIdsAtom,
  )
  const isMultiSelectMode = useAtomValue(isConversationMultiSelectModeAtom)
  const selectedConversationsCount = useAtomValue(selectedConversationsCountAtom)
  const toggleConversationSelection = useSetAtom(toggleConversationSelectionAtom)
  const selectAllConversations = useSetAtom(selectAllConversationsAtom)
  const clearConversationSelection = useSetAtom(clearConversationSelectionAtom)

  // Global desktop/fullscreen state from atoms (initialized in AgentsLayout)
  const isDesktop = useAtomValue(isDesktopAtom)
  const isFullscreen = useAtomValue(isFullscreenAtom)


  // Map open IDs to metadata and sort by updated_at (most recent first)
  const allConversationsById = useMemo(() => {
    const map = new Map<string, ConversationMeta>()
    for (const chat of allConversations) {
      map.set(chat.id, chat)
    }
    return map
  }, [allConversations])

  // Map open IDs to metadata and sort by updated_at (most recent first)
  const openConversations = useMemo(() => {
    const chats = openConversationIds
      .map((id) => allConversationsById.get(id))
      .filter((sc): sc is ConversationMeta => !!sc)
      .sort((a, b) => {
        const aT = new Date(a.updated_at || a.created_at || "0").getTime()
        const bT = new Date(b.updated_at || b.created_at || "0").getTime()
        return bT - aT // Most recent first
      })

    if (splitPaneIds.length < 2) return chats

    const splitIdsSet = new Set(splitPaneIds)
    const firstSplitIdx = chats.findIndex((chat) => splitIdsSet.has(chat.id))
    if (firstSplitIdx < 0) return chats

    const splitChats = chats
      .filter((chat) => splitIdsSet.has(chat.id))
      .sort((a, b) => splitPaneIds.indexOf(a.id) - splitPaneIds.indexOf(b.id))
    const nonSplitChats = chats.filter((chat) => !splitIdsSet.has(chat.id))
    const insertAt = Math.min(firstSplitIdx, nonSplitChats.length)

    return [
      ...nonSplitChats.slice(0, insertAt),
      ...splitChats,
      ...nonSplitChats.slice(insertAt),
    ]
  }, [openConversationIds, allConversationsById, splitPaneIds])
  const splitPaneIdSet = useMemo(() => new Set(splitPaneIds), [splitPaneIds])

  // Filter and separate pinned/unpinned conversations
  const { pinnedChats, unpinnedChats } = useMemo(() => {
    const filtered = searchQuery.trim()
      ? openConversations.filter((chat) =>
          displayText(chat?.name)
            .toLowerCase()
            .includes(searchQuery.toLowerCase()),
        )
      : openConversations

    const pinned = filtered.filter((chat) => pinnedConversationIds.includes(chat.id))
    const unpinned = filtered.filter(
      (chat) => !pinnedConversationIds.includes(chat.id),
    )

    return { pinnedChats: pinned, unpinnedChats: unpinned }
  }, [searchQuery, openConversations, pinnedConversationIds])

  const filteredConversations = useMemo(() => {
    return [...pinnedChats, ...unpinnedChats]
  }, [pinnedChats, unpinnedChats])
  const filteredIndexById = useMemo(() => {
    const map = new Map<string, number>()
    filteredConversations.forEach((chat, idx) => {
      map.set(chat.id, idx)
    })
    return map
  }, [filteredConversations])

  // Reset focused index when search query changes
  React.useEffect(() => {
    setFocusedChatIndex(-1)
  }, [searchQuery, filteredConversations.length])

  // Scroll focused item into view
  React.useEffect(() => {
    if (focusedChatIndex >= 0 && filteredConversations.length > 0) {
      const focusedElement = scrollContainerRef.current?.querySelector(
        `[data-conversation-index="${focusedChatIndex}"]`,
      ) as HTMLElement
      if (focusedElement) {
        focusedElement.scrollIntoView({
          block: "nearest",
          behavior: "smooth",
        })
      }
    }
  }, [focusedChatIndex, filteredConversations.length])

  // Unified scroll handler for gradients (works with both event and direct calls)
  const updateScrollGradients = useCallback((element?: HTMLDivElement) => {
    const container = element || scrollContainerRef.current
    if (!container) return

    const { scrollTop, scrollHeight, clientHeight } = container
    const isScrollable = scrollHeight > clientHeight

    if (!isScrollable) {
      setShowBottomGradient(false)
      setShowTopGradient(false)
      return
    }

    const threshold = 5
    const isAtTop = scrollTop <= threshold
    const isAtBottom = scrollTop + clientHeight >= scrollHeight - threshold

    setShowTopGradient(!isAtTop)
    setShowBottomGradient(!isAtBottom)
  }, [])

  // Handler for React onScroll event
  const handleScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      updateScrollGradients(e.currentTarget)
    },
    [updateScrollGradients],
  )

  // Initialize gradients on mount and observe container size changes
  React.useEffect(() => {
    const container = scrollContainerRef.current
    if (!container) return

    updateScrollGradients()
    const resizeObserver = new ResizeObserver(() => updateScrollGradients())
    resizeObserver.observe(container)

    return () => resizeObserver.disconnect()
  }, [filteredConversations, updateScrollGradients])

  // Hotkey: / to focus search input (only when sidebar is visible and input not focused)
  React.useEffect(() => {
    const handleSearchHotkey = (e: KeyboardEvent) => {
      // Only trigger if / is pressed without Cmd/Ctrl/Alt
      // Note: e.key automatically handles keyboard layouts (Shift is not checked, allowing international layouts)
      if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        // Don't trigger if already focused on an input/textarea
        const activeEl = document.activeElement
        if (
          activeEl?.tagName === "INPUT" ||
          activeEl?.tagName === "TEXTAREA" ||
          activeEl?.hasAttribute("contenteditable")
        ) {
          return
        }

        e.preventDefault()
        e.stopPropagation()
        searchInputRef.current?.focus()
        searchInputRef.current?.select()
      }
    }

    // Use capture phase to intercept before other handlers (e.g., prompt input)
    // Cleanup is guaranteed on unmount to prevent memory leaks
    window.addEventListener("keydown", handleSearchHotkey, { capture: true })
    return () =>
      window.removeEventListener("keydown", handleSearchHotkey, {
        capture: true,
      })
    // Empty deps: handler is stable and uses only ref which doesn't need tracking
  }, [])

  // Derive which conversations are loading (keys = conversationIds)
  const loadingChatIds = useMemo(
    () => new Set([...loadingConversations.keys()]),
    [loadingConversations],
  )

  const handleConversationClick = (conversationId: string) => {
    const store = useAgentConversationStore.getState()
    store.setActiveConversation(conversationId)

    // Clear unseen indicator for this conversation
    setConversationUnseenChanges((prev: Set<string>) => {
      if (prev.has(conversationId)) {
        const next = new Set(prev)
        next.delete(conversationId)
        return next
      }
      return prev
    })
  }

  const handleArchiveConversation = useCallback(
    (conversationId: string) => {
      // If this is the last open conversation, show confirmation dialog
      if (openConversations.length === 1) {
        const conversation = allConversations.find((sc) => sc.id === conversationId)
        if (conversation) {
          setConversationToArchive(conversation)
          setArchiveAgentDialogOpen(true)
        }
        return
      }
      // Archive = remove from open tabs (but keep in allConversations for history)
      useAgentConversationStore.getState().removeFromOpenConversations(conversationId)

      // Add to unified undo stack for Cmd+Z
      if (parentChatId) {
        const timeoutId = setTimeout(() => {
          setUndoStack((prev) => prev.filter(
            (item) => !(item.type === "conversation" && item.conversationId === conversationId)
          ))
        }, 10000)

        setUndoStack((prev) => [...prev, {
          type: "conversation",
          conversationId,
          chatId: parentChatId,
          timeoutId,
        }])
      }
    },
    [openConversations.length, allConversations, parentChatId, setUndoStack],
  )

  const handleConfirmArchiveAgent = useCallback(() => {
    if (parentChatId) {
      // Archive the parent agent chat
      archiveChatMutation.mutate({ id: parentChatId })
    }
    setArchiveAgentDialogOpen(false)
    setConversationToArchive(null)
  }, [parentChatId, archiveChatMutation])

  // Handle conversation card hover for truncated name tooltip (1s delay)
  // Uses direct DOM manipulation instead of state to avoid re-renders
  const handleConversationMouseEnter = useCallback(
    (conversationId: string, name: string, cardElement: HTMLElement) => {
      // Clear any existing timer
      if (conversationTooltipTimerRef.current) {
        clearTimeout(conversationTooltipTimerRef.current)
      }

      const nameEl = conversationNameRefs.current.get(conversationId)
      if (!nameEl) return

      // Check if name is truncated
      const isTruncated = nameEl.scrollWidth > nameEl.clientWidth
      if (!isTruncated) return

      // Show tooltip after 1 second delay via DOM manipulation (no state update)
      conversationTooltipTimerRef.current = setTimeout(() => {
        const tooltip = tooltipRef.current
        if (!tooltip) return

        const rect = cardElement.getBoundingClientRect()
        tooltip.style.display = "block"
        tooltip.style.top = `${rect.top + rect.height / 2}px`
        tooltip.style.left = `${rect.right + 8}px`
        tooltip.textContent = name
      }, 1000)
    },
    [],
  )

  const handleConversationMouseLeave = useCallback(() => {
    // Clear timer if hovering ends before delay
    if (conversationTooltipTimerRef.current) {
      clearTimeout(conversationTooltipTimerRef.current)
      conversationTooltipTimerRef.current = null
    }
    // Hide tooltip via DOM - no state update, no re-render
    const tooltip = tooltipRef.current
    if (tooltip) {
      tooltip.style.display = "none"
    }
  }, [])

  const handleArchiveAllBelow = useCallback(
    (conversationId: string) => {
      const currentIndex = filteredConversations.findIndex((c) => c.id === conversationId)
      if (currentIndex === -1 || currentIndex === filteredConversations.length - 1)
        return

      const state = useAgentConversationStore.getState()
      const idsToClose = filteredConversations
        .slice(currentIndex + 1)
        .map((c) => c.id)

      idsToClose.forEach((id) => state.removeFromOpenConversations(id))

      // Add each to unified undo stack for Cmd+Z
      if (parentChatId) {
        const newItems: UndoItem[] = idsToClose.map((id) => {
          const timeoutId = setTimeout(() => {
            setUndoStack((prev) => prev.filter(
              (item) => !(item.type === "conversation" && item.conversationId === id)
            ))
          }, 10000)
          return { type: "conversation" as const, conversationId: id, chatId: parentChatId, timeoutId }
        })
        setUndoStack((prev) => [...prev, ...newItems])
      }
    },
    [filteredConversations, parentChatId, setUndoStack],
  )

  const onCloseOtherChats = useCallback((conversationId: string) => {
    const state = useAgentConversationStore.getState()
    const idsToClose = state.openConversationIds.filter((id) => id !== conversationId)
    idsToClose.forEach((id) => state.removeFromOpenConversations(id))
    state.setActiveConversation(conversationId)

    // Add each to unified undo stack for Cmd+Z
    if (parentChatId) {
      const newItems: UndoItem[] = idsToClose.map((id) => {
        const timeoutId = setTimeout(() => {
          setUndoStack((prev) => prev.filter(
            (item) => !(item.type === "conversation" && item.conversationId === id)
          ))
        }, 10000)
        return { type: "conversation" as const, conversationId: id, chatId: parentChatId, timeoutId }
      })
      setUndoStack((prev) => [...prev, ...newItems])
    }
  }, [parentChatId, setUndoStack])

  const renameMutation = api.agents.renameConversation.useMutation({
    // Note: store is updated optimistically in handleRenameSave, no need for onSuccess
    onError: (error) => {
      if (error.data?.code === "NOT_FOUND") {
        toast.error("Send a message first before renaming this conversation")
      } else {
        toast.error("Failed to rename conversation")
      }
    },
  })

  const handleRenameClick = useCallback((conversation?: ConversationMeta) => {
    setRenamingConversation(conversation ?? null)
    setRenameDialogOpen(true)
  }, [])

  const handleRenameSave = useCallback(
    async (newName: string) => {
      if (!renamingConversation) return

      const conversationId = renamingConversation.id
      const oldName = renamingConversation.name

      // Optimistically update store
      useAgentConversationStore.getState().updateConversationName(conversationId, newName)

      // Remove from justCreatedIds to prevent typewriter animation on manual rename
      setJustCreatedIds((prev) => {
        if (prev.has(conversationId)) {
          const next = new Set(prev)
          next.delete(conversationId)
          return next
        }
        return prev
      })

      setRenameLoading(true)

      try {
        await renameMutation.mutateAsync({
          conversationId: conversationId,
          title: newName,
        })
      } catch {
        // Rollback on error
        useAgentConversationStore
          .getState()
          .updateConversationName(conversationId, oldName || "New Chat")
      } finally {
        setRenameLoading(false)
        setRenamingConversation(null)
      }
    },
    [renamingConversation, renameMutation, setJustCreatedIds],
  )

  const handleSelectFromHistory = useCallback((conversation?: ConversationMeta) => {
    if (!conversation?.id) return
    const state = useAgentConversationStore.getState()
    const isAlreadyOpen = state.openConversationIds.includes(conversation.id)

    if (!isAlreadyOpen) {
      state.addToOpenConversations(conversation.id)
    }
    state.setActiveConversation(conversation.id)
  }, [])

  // Sort conversations by most recent first for history
  const sortedConversations = useMemo(
    () =>
      [...allConversations].sort((a, b) => {
        const aT = new Date(a.updated_at || a.created_at || "0").getTime()
        const bT = new Date(b.updated_at || b.created_at || "0").getTime()
        return bT - aT
      }),
    [allConversations],
  )

  // Update gradients when filtered chats change or on resize
  useEffect(() => {
    updateScrollGradients()
  }, [filteredConversations, updateScrollGradients])

  // Update gradients on window resize
  useEffect(() => {
    const handleResize = () => updateScrollGradients()
    window.addEventListener("resize", handleResize, { passive: true })
    return () => window.removeEventListener("resize", handleResize)
  }, [updateScrollGradients])

  // Cleanup pending timers on unmount
  useEffect(() => {
    return () => {
      if (conversationTooltipTimerRef.current) {
        clearTimeout(conversationTooltipTimerRef.current)
      }
      // Clear undo stack timeouts
      const undoStack = appStore.get(undoStackAtom)
      undoStack.forEach((item) => clearTimeout(item.timeoutId))
    }
  }, [])

  // Check if all selected conversations are pinned
  const areAllSelectedPinned = useMemo(() => {
    if (selectedConversationIds.size === 0) return false
    return Array.from(selectedConversationIds).every((id) =>
      pinnedConversationIds.includes(id),
    )
  }, [selectedConversationIds, pinnedConversationIds])

  // Check if all selected conversations are unpinned
  const areAllSelectedUnpinned = useMemo(() => {
    if (selectedConversationIds.size === 0) return false
    return Array.from(selectedConversationIds).every(
      (id) => !pinnedConversationIds.includes(id),
    )
  }, [selectedConversationIds, pinnedConversationIds])

  // Show pin option only if all selected have same pin state
  const canShowPinOption = areAllSelectedPinned || areAllSelectedUnpinned

  // Handle bulk pin of selected conversations
  const handleBulkPin = useCallback(() => {
    const idsToPin = Array.from(selectedConversationIds)
    if (idsToPin.length > 0) {
      idsToPin.forEach((id) => {
        if (!pinnedConversationIds.includes(id)) {
          togglePinConversation(id)
        }
      })
      clearConversationSelection()
    }
  }, [
    selectedConversationIds,
    pinnedConversationIds,
    togglePinConversation,
    clearConversationSelection,
  ])

  // Handle bulk unpin of selected conversations
  const handleBulkUnpin = useCallback(() => {
    const idsToUnpin = Array.from(selectedConversationIds)
    if (idsToUnpin.length > 0) {
      idsToUnpin.forEach((id) => {
        if (pinnedConversationIds.includes(id)) {
          togglePinConversation(id)
        }
      })
      clearConversationSelection()
    }
  }, [
    selectedConversationIds,
    pinnedConversationIds,
    togglePinConversation,
    clearConversationSelection,
  ])

  // Handle bulk archive of selected conversations
  const handleBulkArchive = useCallback(() => {
    const idsToArchive = Array.from(selectedConversationIds)
    if (idsToArchive.length > 0) {
      // Check if closing all open tabs
      const remainingOpenIds = openConversationIds.filter(
        (id) => !idsToArchive.includes(id),
      )

      if (remainingOpenIds.length === 0) {
        // Closing all tabs - show archive agent confirmation
        const firstConversation = allConversations.find((sc) =>
          idsToArchive.includes(sc.id),
        )
        if (firstConversation) {
          setConversationToArchive(firstConversation)
          setArchiveAgentDialogOpen(true)
          clearConversationSelection()
        }
      } else {
        // Some tabs remain - just close selected ones
        const state = useAgentConversationStore.getState()
        idsToArchive.forEach((id) => state.removeFromOpenConversations(id))
        clearConversationSelection()

        // Add each to unified undo stack for Cmd+Z
        if (parentChatId) {
          const newItems: UndoItem[] = idsToArchive.map((id) => {
            const timeoutId = setTimeout(() => {
              setUndoStack((prev) => prev.filter(
                (item) => !(item.type === "conversation" && item.conversationId === id)
              ))
            }, 10000)
            return { type: "conversation" as const, conversationId: id, chatId: parentChatId, timeoutId }
          })
          setUndoStack((prev) => [...prev, ...newItems])
        }
      }
    }
  }, [selectedConversationIds, openConversationIds, allConversations, clearConversationSelection, parentChatId, setUndoStack])

  // Handle checkbox click
  const handleCheckboxClick = (e: React.MouseEvent, conversationId: string) => {
    e.stopPropagation()
    toggleConversationSelection(conversationId)
  }

  // Handle conversation item click with shift support
  const handleConversationItemClick = (
    conversationId: string,
    e?: React.MouseEvent,
    globalIndex?: number,
  ) => {
    // Shift+click for range selection
    if (e?.shiftKey) {
      e.preventDefault()

      const clickedIndex =
        globalIndex ?? filteredConversations.findIndex((c) => c.id === conversationId)

      if (clickedIndex === -1) return

      // Find the anchor: use active conversation
      let anchorIndex = -1

      if (activeConversationId) {
        anchorIndex = filteredConversations.findIndex(
          (c) => c.id === activeConversationId,
        )
      }

      // If no active conversation, try to use the first selected item
      if (anchorIndex === -1 && selectedConversationIds.size > 0) {
        for (let i = 0; i < filteredConversations.length; i++) {
          if (selectedConversationIds.has(filteredConversations[i]!.id)) {
            anchorIndex = i
            break
          }
        }
      }

      // If still no anchor, just select the clicked item
      if (anchorIndex === -1) {
        if (!selectedConversationIds.has(conversationId)) {
          toggleConversationSelection(conversationId)
        }
        return
      }

      // Select range from anchor to clicked item
      const startIndex = Math.min(anchorIndex, clickedIndex)
      const endIndex = Math.max(anchorIndex, clickedIndex)

      const newSelection = new Set(selectedConversationIds)
      for (let i = startIndex; i <= endIndex; i++) {
        const chat = filteredConversations[i]
        if (chat) {
          newSelection.add(chat.id)
        }
      }
      setSelectedConversationIds(newSelection)
      return
    }

    // Normal click - navigate to conversation
    handleConversationClick(conversationId)
  }

  // Multi-select hotkeys
  // X to toggle selection of hovered or focused chat
  useHotkeys(
    "x",
    () => {
      if (!filteredConversations || filteredConversations.length === 0) return

      // Prefer hovered (via ref), then focused
      const targetIndex =
        hoveredChatIndexRef.current >= 0
          ? hoveredChatIndexRef.current
          : focusedChatIndex >= 0
            ? focusedChatIndex
            : -1

      if (targetIndex >= 0 && targetIndex < filteredConversations.length) {
        const conversationId = filteredConversations[targetIndex]!.id
        toggleConversationSelection(conversationId)
      }
    },
    [
      filteredConversations,
      focusedChatIndex,
      toggleConversationSelection,
    ],
  )

  // Cmd+A / Ctrl+A to select all conversations (only when at least one is already selected)
  useHotkeys(
    "mod+a",
    (e) => {
      if (isMultiSelectMode && filteredConversations.length > 0) {
        e.preventDefault()
        selectAllConversations(filteredConversations.map((c) => c.id))
      }
    },
    [filteredConversations, selectAllConversations, isMultiSelectMode],
  )

  // Escape to clear selection (but not when dialogs are open)
  useHotkeys(
    "escape",
    () => {
      if (archiveAgentDialogOpen || renameDialogOpen) return
      if (isMultiSelectMode) {
        clearConversationSelection()
        setFocusedChatIndex(-1)
      }
    },
    [
      isMultiSelectMode,
      clearConversationSelection,
      archiveAgentDialogOpen,
      renameDialogOpen,
    ],
  )

  // Clear selection when parent chat changes
  useEffect(() => {
    clearConversationSelection()
  }, [parentChatId, clearConversationSelection])

  // Drafts cache - uses event-based sync instead of polling
  const draftsCache = useConversationDraftsCache()

  // Get draft for a conversation
  const getDraftText = useCallback(
    (conversationId: string): string | null => {
      if (!parentChatId) return null
      const key = getConversationDraftKey(parentChatId, conversationId)
      return draftsCache[key] || null
    },
    [parentChatId, draftsCache],
  )

  // History and Close buttons - reusable element
  const headerButtons = onClose && (
    <div className="flex items-center gap-1">
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
  )

  const renderConversationItem = (conversation: (typeof filteredConversations)[number]) => {
    const isConversationLoading = loadingChatIds.has(conversation?.id)
    const isActive = activeConversationId === conversation?.id
    const isPinned = pinnedConversationIds.includes(conversation?.id)
    const globalIndex = filteredIndexById.get(conversation?.id) ?? -1
    const isSplitTab = splitPaneIdSet.has(conversation?.id)
    const hasSplitPrev =
      isSplitTab &&
      globalIndex > 0 &&
      splitPaneIdSet.has(filteredConversations[globalIndex - 1]?.id)
    const hasSplitNext =
      isSplitTab &&
      globalIndex >= 0 &&
      globalIndex < filteredConversations.length - 1 &&
      splitPaneIdSet.has(filteredConversations[globalIndex + 1]?.id)
    const isFocused =
      focusedChatIndex === globalIndex &&
      focusedChatIndex >= 0
    const hasUnseen = conversationsUnseenChanges.has(conversation?.id || "")
    const timeAgo = formatTimeAgo(
      conversation?.updated_at || conversation?.created_at,
    )
    const mode = conversation?.mode || "agent"
    const isChecked = selectedConversationIds.has(conversation?.id)
    const draftText = getDraftText(conversation?.id)
    const hasPendingQuestion = pendingQuestionsMap.has(conversation?.id || "")
    const hasPendingPlan = pendingPlanApprovals.has(conversation?.id)
    const fileChanges = conversationFiles.get(conversation?.id) || []
    const stats =
      fileChanges.length > 0
        ? fileChanges.reduce(
            (acc, f) => ({
              fileCount: acc.fileCount + 1,
              additions: acc.additions + f.additions,
              deletions: acc.deletions + f.deletions,
            }),
            { fileCount: 0, additions: 0, deletions: 0 },
          )
        : null

    return (
      <ContextMenu key={conversation?.id}>
        <ContextMenuTrigger asChild>
          <div
            data-testid={`conversation-item-${conversation?.id}`}
            data-conversation-index={globalIndex}
            onClick={(e) =>
              handleConversationItemClick(
                conversation?.id,
                e,
                globalIndex,
              )
            }
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault()
                handleConversationItemClick(
                  conversation?.id,
                  undefined,
                  globalIndex,
                )
              }
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault()
                const nextIndex = e.key === "ArrowDown" ? globalIndex + 1 : globalIndex - 1
                const container = (e.currentTarget as HTMLElement).closest("[data-sidebar-scroll]")
                const nextEl = container?.querySelector<HTMLElement>(`[data-conversation-index="${nextIndex}"]`)
                if (nextEl) {
                  appStore.set(suppressInputFocusAtom, true)
                  nextEl.click()
                  nextEl.focus()
                  nextEl.scrollIntoView({ block: "nearest" })
                }
              }
            }}
            onMouseEnter={(e) => {
              hoveredChatIndexRef.current = globalIndex
              handleConversationMouseEnter(
                conversation?.id,
                conversation?.name || "New Chat",
                e.currentTarget,
              )
            }}
            onMouseLeave={() => {
              hoveredChatIndexRef.current = -1
              handleConversationMouseLeave()
            }}
            className={cn(
              "w-full text-left py-1.5 transition-colors duration-75 cursor-pointer group relative",
              "outline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring/70",
              isMultiSelectMode ? "px-3" : "pl-2 pr-2",
              isMultiSelectMode ? "" : "rounded-md",
              isActive
                ? "bg-foreground/5 text-foreground"
                : isChecked
                  ? "bg-foreground/5 text-foreground"
                  : isFocused
                    ? "bg-foreground/5 text-foreground"
                    : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
              isSplitTab && !isMultiSelectMode && "border border-border/60",
              isSplitTab && !isMultiSelectMode && !isActive && !isChecked && !isFocused && "bg-muted/40 hover:bg-muted/50",
              isSplitTab && !isMultiSelectMode && hasSplitPrev && "-mt-px rounded-t-none",
              isSplitTab && !isMultiSelectMode && hasSplitNext && "rounded-b-none",
            )}
          >
            <div className="flex items-start gap-2.5">
              {/* Icon/Checkbox container */}
              <div className="pt-0.5 flex-shrink-0 w-4 h-4 flex items-center justify-center relative">
                {/* Checkbox - shown in multi-select mode */}
                <div
                  className={cn(
                    "absolute inset-0 flex items-center justify-center transition-[opacity,transform] duration-150 ease-out",
                    isMultiSelectMode
                      ? "opacity-100 scale-100"
                      : "opacity-0 scale-95 pointer-events-none",
                  )}
                  onClick={(e) =>
                    handleCheckboxClick(e, conversation?.id)
                  }
                >
                  <Checkbox
                    checked={isChecked}
                    className="cursor-pointer h-4 w-4"
                    tabIndex={isMultiSelectMode ? 0 : -1}
                  />
                </div>
                {/* Mode icon or Question icon - hidden in multi-select mode */}
                <div
                  className={cn(
                    "transition-[opacity,transform] duration-150 ease-out",
                    isMultiSelectMode
                      ? "opacity-0 scale-95 pointer-events-none"
                      : "opacity-100 scale-100",
                  )}
                >
                  {hasPendingQuestion ? (
                    <QuestionIcon className="w-4 h-4 text-blue-500" />
                  ) : mode === "plan" ? (
                    <PlanIcon className="w-4 h-4 text-muted-foreground" />
                  ) : (
                    <AgentIcon className="w-4 h-4 text-muted-foreground" />
                  )}
                </div>
                {/* Badge in bottom-right corner - hidden in multi-select mode and when pending question */}
                {(isConversationLoading || hasUnseen || hasPendingPlan) &&
                  !isMultiSelectMode && !hasPendingQuestion && (
                    <div
                      className={cn(
                        "absolute -bottom-1 -right-1 w-3 h-3 rounded-full flex items-center justify-center",
                        isActive
                          ? "bg-[#E8E8E8] dark:bg-[#1B1B1B]"
                          : "bg-[#F4F4F4] group-hover:bg-[#E8E8E8] dark:bg-[#101010] dark:group-hover:bg-[#1B1B1B]",
                      )}
                    >
                      {/* Priority: loader > amber dot (pending plan) > blue dot (unseen) */}
                      {isConversationLoading ? (
                        <LoadingDot isLoading={true} className="w-2.5 h-2.5 text-muted-foreground" />
                      ) : hasPendingPlan ? (
                        <div className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                      ) : (
                        <LoadingDot isLoading={false} className="w-2.5 h-2.5 text-muted-foreground" />
                      )}
                    </div>
                  )}
              </div>
              <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                <div className="flex items-center gap-1">
                  <span
                    ref={(el) => {
                      if (el) {
                        conversationNameRefs.current.set(conversation?.id, el)
                      } else {
                        conversationNameRefs.current.delete(conversation?.id)
                      }
                    }}
                    className="truncate block text-sm leading-tight flex-1"
                  >
                    <TypewriterText
                      text={conversation?.name || ""}
                      placeholder="New Chat"
                      id={conversation?.id}
                      isJustCreated={justCreatedIds.has(conversation?.id)}
                      showPlaceholder={true}
                    />
                  </span>
                  {!isMultiSelectMode && (
                    <ConversationDropdownMenu
                      conversation={conversation}
                      isPinned={isPinned}
                      onTogglePin={togglePinConversation}
                      onRename={handleRenameClick}
                      onArchive={handleArchiveConversation}
                      onArchiveAllBelow={handleArchiveAllBelow}
                      onArchiveOthers={onCloseOtherChats}
                      isOnlyChat={openConversations.length === 1}
                      currentIndex={globalIndex}
                      totalCount={filteredConversations.length}
                      chatId={parentChatId}
                      onOpenInSplit={addToSplit}
                      onCloseSplit={closeSplit}
                      onRemoveFromSplit={removeFromSplit}
                      splitPaneCount={splitPaneIds.length}
                      isActiveTab={isActive}
                      isSplitTab={isSplitTab}
                    />
                  )}
                </div>
                <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground/60 min-w-0">
                  {draftText ? (
                    <span className="truncate flex-1 min-w-0">
                      <span className="text-blue-500">Draft:</span>{" "}
                      {draftText}
                    </span>
                  ) : (
                    <span className="truncate flex-1 min-w-0">
                      {stats ? (
                        <>
                          {stats.fileCount}{" "}
                          {stats.fileCount === 1
                            ? "file"
                            : "files"}
                        </>
                      ) : null}
                    </span>
                  )}
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    {!draftText && stats && (stats.additions > 0 || stats.deletions > 0) && (
                      <>
                        <span className="text-green-600 dark:text-green-400">
                          +{stats.additions}
                        </span>
                        <span className="text-red-600 dark:text-red-400">
                          -{stats.deletions}
                        </span>
                      </>
                    )}
                    <span>{timeAgo}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </ContextMenuTrigger>
        {/* Multi-select context menu */}
        {isMultiSelectMode &&
        selectedConversationIds.has(conversation?.id) ? (
          <ContextMenuContent className="w-48">
            {canShowPinOption && (
              <>
                <ContextMenuItem
                  onClick={
                    areAllSelectedPinned
                      ? handleBulkUnpin
                      : handleBulkPin
                  }
                >
                  {areAllSelectedPinned
                    ? `Unpin ${selectedConversationIds.size} ${pluralize(selectedConversationIds.size, "conversation")}`
                    : `Pin ${selectedConversationIds.size} ${pluralize(selectedConversationIds.size, "conversation")}`}
                </ContextMenuItem>
                <ContextMenuSeparator />
              </>
            )}
            <ContextMenuItem onClick={handleBulkArchive}>
              Archive {selectedConversationIds.size}{" "}
              {pluralize(selectedConversationIds.size, "conversation")}
            </ContextMenuItem>
          </ContextMenuContent>
        ) : (
          <ConversationContextMenu
            conversation={conversation}
            isPinned={isPinned}
            onTogglePin={togglePinConversation}
            onRename={handleRenameClick}
            onArchive={handleArchiveConversation}
            onArchiveAllBelow={handleArchiveAllBelow}
            onArchiveOthers={onCloseOtherChats}
            isOnlyChat={openConversations.length === 1}
            currentIndex={globalIndex}
            totalCount={filteredConversations.length}
            chatId={parentChatId}
            onOpenInSplit={addToSplit}
            onCloseSplit={closeSplit}
            onRemoveFromSplit={removeFromSplit}
            splitPaneCount={splitPaneIds.length}
            isActiveTab={isActive}
            isSplitTab={isSplitTab}
          />
        )}
      </ContextMenu>
    )
  }

  const ConversationSection = ({
    title,
    items,
    bottomMargin,
  }: {
    title: string
    items: typeof filteredConversations
    bottomMargin?: boolean
  }) => {
    if (items.length === 0) return null
    return (
      <>
        <div
          className={cn(
            "flex items-center h-4 mb-1",
            isMultiSelectMode ? "pl-3" : "pl-2",
          )}
        >
          <h3 className="text-xs font-medium text-muted-foreground whitespace-nowrap">
            {title}
          </h3>
        </div>
        <div className={cn("list-none p-0 m-0", bottomMargin && "mb-3")}>
          {items.map(renderConversationItem)}
        </div>
      </>
    )
  }

  return (
    <div
      data-testid="conversation-sidebar"
      className="flex flex-col h-full bg-background border-r overflow-hidden relative"
      style={{ borderRightWidth: "0.5px" }}
    >
      {/* Draggable area for window movement - background layer (hidden in fullscreen) */}
      {isDesktop && !isFullscreen && (
        <div
          className="absolute inset-0 z-0"
          style={{
            // @ts-expect-error - WebKit-specific property
            WebkitAppRegion: "drag",
          }}
        />
      )}

      {/* Spacer for macOS traffic lights - only when agents sidebar is open */}
      {isSidebarOpen && (
        <TrafficLightSpacer isDesktop={isDesktop} isFullscreen={isFullscreen} />
      )}

      {/* Header buttons - absolutely positioned when agents sidebar is open */}
      {isSidebarOpen && (
        <div
          className="absolute right-2 top-2 z-20"
          style={{
            // @ts-expect-error - WebKit-specific property
            WebkitAppRegion: "no-drag",
          }}
        >
          {headerButtons}
        </div>
      )}

      {/* Header */}
      <div className="p-2 pb-3 flex-shrink-0 relative z-10">
        <div className="space-y-2">
          {/* Top row - different layout based on agents sidebar state */}
          {isSidebarOpen ? (
            <div className="h-6" />
          ) : (
            <div className="flex items-center justify-between gap-1 mb-1">
              {onBackToChats && (
                <Tooltip delayDuration={500}>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={onBackToChats}
                      tabIndex={-1}
                      className="h-6 w-6 p-0 hover:bg-foreground/10 transition-[background-color,transform] duration-150 ease-out active:scale-[0.97] flex-shrink-0 rounded-md"
                      aria-label="Toggle agents sidebar"
                      style={{
                        // @ts-expect-error - WebKit-specific property
                        WebkitAppRegion: "no-drag",
                      }}
                    >
                      <AlignJustify className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Open chats sidebar</TooltipContent>
                </Tooltip>
              )}
              <div className="flex-1" />
              <div
                style={{
                  // @ts-expect-error - WebKit-specific property
                  WebkitAppRegion: "no-drag",
                }}
              >
                {headerButtons}
              </div>
            </div>
          )}
          {/* Search Input */}
          <div
            className="relative"
            style={{
              // @ts-expect-error - WebKit-specific property
              WebkitAppRegion: "no-drag",
            }}
          >
            <Input
              ref={searchInputRef}
              data-testid="conversation-search-input"
              placeholder={collaborationModeConfig.conversationSearchPlaceholder}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault()
                  searchInputRef.current?.blur()
                  setFocusedChatIndex(-1)
                  return
                }

                if (e.key === "ArrowDown") {
                  e.preventDefault()
                  setFocusedChatIndex((prev) => {
                    if (prev === -1) return 0
                    return prev < filteredConversations.length - 1 ? prev + 1 : prev
                  })
                  return
                }

                if (e.key === "ArrowUp") {
                  e.preventDefault()
                  setFocusedChatIndex((prev) => {
                    if (prev === -1) return filteredConversations.length - 1
                    return prev > 0 ? prev - 1 : prev
                  })
                  return
                }

                if (e.key === "Enter") {
                  e.preventDefault()
                  if (focusedChatIndex >= 0) {
                    const focusedChat = filteredConversations[focusedChatIndex]
                    if (focusedChat) {
                      handleConversationClick(focusedChat.id)
                      searchInputRef.current?.blur()
                      setFocusedChatIndex(-1)
                    }
                  }
                  return
                }
              }}
              className="h-7 w-full rounded-lg text-sm bg-muted border border-input placeholder:text-muted-foreground/40"
            />
          </div>
          {/* New Chat / Group Button */}
          <div
            style={{
              // @ts-expect-error - WebKit-specific property
              WebkitAppRegion: "no-drag",
            }}
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
                  <span className="text-sm font-medium">
                    {collaborationModeConfig.conversationButtonLabel}
                  </span>
                </Button>
              </TooltipTrigger>
            <TooltipContent side="right">
              {workspaceId
                ? collaborationModeConfig.conversationButtonTooltip
                : "Select a workspace first"}
              {newAgentHotkey && <Kbd>{newAgentHotkey}</Kbd>}
            </TooltipContent>
          </Tooltip>
          </div>
        </div>
      </div>

      {/* Scrollable conversations list */}
      <div
        className="flex-1 min-h-0 relative z-10"
        style={{
          // @ts-expect-error - WebKit-specific property
          WebkitAppRegion: "no-drag",
        }}
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
              onScroll={handleScroll}
              className={cn(
                "h-full overflow-y-auto scrollbar-thin scrollbar-thumb-muted-foreground/20 scrollbar-track-transparent",
                isMultiSelectMode ? "px-0" : "px-2",
              )}
            >
              <WorkspaceChatList
                workspaceId={workspaceId}
                searchQuery={searchQuery}
                selectedChatId={selectedChatId}
                onChatSelect={onChatSelect}
              />

              {filteredConversations.length > 0 ? (
                <div
                  className={cn("mb-4", isMultiSelectMode ? "px-0" : "-mx-1")}
                >
                  <ConversationSection title="Pinned Chats" items={pinnedChats} bottomMargin />
                  <ConversationSection
                    title={pinnedChats.length > 0 ? "Recent Chats" : "Chats"}
                    items={unpinnedChats}
                  />
                </div>
              ) : null}
            </div>
        </div>
      </div>

      {/* Multi-select Footer Toolbar */}
      <AnimatePresence mode="wait">
        {isMultiSelectMode && (
          <motion.div
            key="multiselect-footer"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0 }}
            className="flex-shrink-0 p-2 bg-background space-y-2 relative z-10"
            style={{
              // @ts-expect-error - WebKit-specific property
              WebkitAppRegion: "no-drag",
            }}
          >
            <div className="flex items-center justify-between px-1">
              <span className="text-xs text-muted-foreground">
                {selectedConversationsCount} selected
              </span>
              <button
                onClick={clearConversationSelection}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                Cancel
              </button>
            </div>

            <div className="flex items-center gap-1.5">
              <Button
                variant="outline"
                size="sm"
                onClick={handleBulkArchive}
                className="flex-1 h-8 gap-1.5 text-xs rounded-lg"
              >
                <ArchiveIcon className="h-3.5 w-3.5" />
                Archive
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Rename Dialog */}
      <AgentsRenameConversationDialog
        isOpen={renameDialogOpen}
        onClose={() => {
          setRenameDialogOpen(false)
          setRenamingConversation(null)
        }}
        onSave={handleRenameSave}
        currentName={renamingConversation?.name || ""}
        isLoading={renameLoading}
      />

      {/* Archive Agent Confirmation Dialog */}
      <AlertDialog
        open={archiveAgentDialogOpen}
        onOpenChange={(open) => {
          setArchiveAgentDialogOpen(open)
          if (!open) {
            setConversationToArchive(null)
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive conversation</AlertDialogTitle>
          </AlertDialogHeader>
          <AlertDialogDescription className="px-5 pb-5">
            Do you want to archive chat{" "}
            <span className="font-medium text-foreground">
              {agentName || conversationToArchive?.name || "this conversation"}
            </span>
            ? You can restore it from history later.
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmArchiveAgent}
              autoFocus
            >
              Archive
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Conversation name tooltip portal - always rendered, visibility controlled via ref */}
      {typeof document !== "undefined" &&
        createPortal(
          <div
            ref={tooltipRef}
            className="fixed z-[100000] max-w-xs px-2 py-1 text-xs bg-popover border border-border rounded-md shadow-lg pointer-events-none text-foreground/90 whitespace-nowrap"
            style={{
              display: "none",
              transform: "translateY(-50%)",
            }}
          />,
          document.body,
        )}
    </div>
  )
}
