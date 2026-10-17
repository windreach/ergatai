"use client"

import { useCallback, useMemo, useEffect, useRef, useState, memo, forwardRef, useImperativeHandle } from "react"
import { useAtom, useAtomValue, useSetAtom } from "jotai"
import {
  loadingConversationsAtom,
  agentsConversationUnseenChangesAtom,
  agentsConversationsSidebarModeAtom,
  pendingUserQuestionsAtom,
} from "../atoms"
import {
  widgetVisibilityAtomFamily,
  unifiedSidebarEnabledAtom,
} from "../../details-sidebar/atoms"
import { trpc } from "../../../lib/trpc"
import { Plus, AlignJustify, Play, TerminalSquare, X } from "lucide-react"
import {
  IconSpinner,
  PlanIcon,
  AgentIcon,
  IconOpenSidebarRight,
  PinFilledIcon,
  DiffIcon,
  ClockIcon,
  QuestionIcon,

} from "../../../components/ui/icons"
import { Button } from "../../../components/ui/button"
import { cn } from "../../../lib/utils"
import {
  useAgentConversationStore,
  type ConversationMeta,
} from "../stores/conversation-store"
import { useShallow } from "zustand/react/shallow"
import { PopoverTrigger } from "../../../components/ui/popover"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../../../components/ui/tooltip"
import { Kbd } from "../../../components/ui/kbd"
import { getShortcutKey } from "../../../lib/utils/platform"
import { useResolvedHotkeyDisplay } from "../../../lib/hotkeys"
import {
  ContextMenu,
  ContextMenuTrigger,
} from "../../../components/ui/context-menu"
import { InlineEdit } from "./inline-edit"
import { api } from "../../../lib/api-adapter"
import { toast } from "sonner"
import { SearchCombobox } from "../../../components/ui/search-combobox"
import { ConversationContextMenu } from "./conversation-context-menu"
import { formatTimeAgo } from "../utils/format-time-ago"

interface DiffStats {
  fileCount: number
  additions: number
  deletions: number
  isLoading: boolean
  hasChanges: boolean
}

// Isolated Search History Popover - prevents parent re-renders when popover opens/closes
interface SearchHistoryPopoverProps {
  sortedConversations: ConversationMeta[]
  loadingConversations: Map<string, string>
  conversationsUnseenChanges: Set<string>
  pendingQuestionsMap: Map<string, { conversationId: string }>
  pendingPlanApprovals: Set<string>
  allConversationsLength: number
  onSelect: (conversation?: ConversationMeta) => void
}

export interface SearchHistoryPopoverRef {
  open: () => void
}

const SearchHistoryPopover = memo(forwardRef<SearchHistoryPopoverRef, SearchHistoryPopoverProps>(function SearchHistoryPopover({
  sortedConversations,
  loadingConversations,
  conversationsUnseenChanges,
  pendingQuestionsMap,
  pendingPlanApprovals,
  allConversationsLength,
  onSelect,
}, ref) {
  const [isHistoryOpen, setIsHistoryOpen] = useState(false)

  // Expose open function to parent
  useImperativeHandle(ref, () => ({
    open: () => setIsHistoryOpen(true)
  }), [])

  const renderItem = useCallback((conversation?: ConversationMeta) => {
    const timeAgo = formatTimeAgo(conversation?.updated_at || conversation?.created_at)
    const isLoading = loadingConversations.has(conversation?.id || "")
    const hasUnseen = conversationsUnseenChanges.has(conversation?.id || "")
    const mode = conversation?.mode || "agent"
    const hasPendingQuestion = pendingQuestionsMap.has(conversation?.id || "")
    const hasPendingPlan = pendingPlanApprovals.has(conversation?.id || "")

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
          {(hasPendingPlan || hasUnseen) && !isLoading && !hasPendingQuestion && (
            <div className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-popover flex items-center justify-center">
              <div className={cn(
                "w-1.5 h-1.5 rounded-full",
                hasPendingPlan ? "bg-amber-500" : "bg-[#307BD0]"
              )} />
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
  }, [loadingConversations, conversationsUnseenChanges, pendingQuestionsMap, pendingPlanApprovals])

  return (
    <SearchCombobox
      isOpen={isHistoryOpen}
      onOpenChange={setIsHistoryOpen}
      items={sortedConversations}
      onSelect={onSelect}
      placeholder="Search chats..."
      emptyMessage="No results"
      getItemValue={(conversation) => `${conversation?.name || "New Chat"} ${conversation?.id}`}
      renderItem={renderItem}
      trigger={
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 p-0 hover:bg-foreground/10 transition-[background-color,transform] duration-150 ease-out active:scale-[0.97] flex-shrink-0 rounded-md flex items-center justify-center"
                disabled={allConversationsLength === 0}
              >
                <ClockIcon className="h-4 w-4" />
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            Search chats
            <Kbd>/</Kbd>
          </TooltipContent>
        </Tooltip>
      }
    />
  )
}))

interface ConversationSelectorProps {
  onCreateNew: () => void
  isMobile?: boolean
  onBackToChats?: () => void
  onOpenPreview?: () => void
  canOpenPreview?: boolean
  onOpenDiff?: () => void
  canOpenDiff?: boolean
  isDiffSidebarOpen?: boolean
  diffStats?: DiffStats
  onOpenTerminal?: () => void
  canOpenTerminal?: boolean
  isTerminalOpen?: boolean
  chatId?: string
}

export function ConversationSelector({
  onCreateNew,
  isMobile = false,
  onBackToChats,
  onOpenPreview,
  canOpenPreview = false,
  onOpenDiff,
  canOpenDiff = false,
  isDiffSidebarOpen = false,
  diffStats,
  onOpenTerminal,
  canOpenTerminal = false,
  isTerminalOpen = false,
  chatId,
}: ConversationSelectorProps) {
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
  const conversationsUnseenChanges = useAtomValue(agentsConversationUnseenChangesAtom)
  const setConversationUnseenChanges = useSetAtom(agentsConversationUnseenChangesAtom)
  const [conversationsSidebarMode, setConversationsSidebarMode] = useAtom(
    agentsConversationsSidebarModeAtom,
  )
  const pendingQuestionsMap = useAtomValue(pendingUserQuestionsAtom)

  // Overview sidebar state - to check if widgets are visible
  const isUnifiedSidebarEnabled = useAtomValue(unifiedSidebarEnabledAtom)
  const widgetVisibilityAtom = useMemo(
    () => widgetVisibilityAtomFamily(chatId || ""),
    [chatId],
  )
  const widgetVisibility = useAtomValue(widgetVisibilityAtom)

  // Show standalone buttons when the widget is not active in the unified sidebar.
  const showDiffButton = !isUnifiedSidebarEnabled || !widgetVisibility.includes("diff")
  const showTerminalButton = !isUnifiedSidebarEnabled || !widgetVisibility.includes("terminal")

  // Resolved hotkeys for tooltips
  const openDiffHotkey = useResolvedHotkeyDisplay("open-diff")
  const toggleTerminalHotkey = useResolvedHotkeyDisplay("toggle-terminal")
  const archiveAgentHotkey = useResolvedHotkeyDisplay("archive-agent")
  const newAgentHotkey = useResolvedHotkeyDisplay("new-agent")

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

  const tabsContainerRef = useRef<HTMLDivElement>(null)
  const tabRefs = useRef<Map<string, HTMLButtonElement>>(new Map())
  const textRefs = useRef<Map<string, HTMLSpanElement>>(new Map())
  // Using refs instead of state for gradients and truncation to avoid re-renders
  const leftGradientRef = useRef<HTMLDivElement>(null)
  const rightGradientRef = useRef<HTMLDivElement>(null)
  const truncatedTabsRef = useRef<Set<string>>(new Set())
  const searchHistoryPopoverRef = useRef<SearchHistoryPopoverRef>(null)

  const allConversationsById = useMemo(() => {
    const map = new Map<string, ConversationMeta>()
    for (const chat of allConversations) {
      map.set(chat.id, chat)
    }
    return map
  }, [allConversations])

  // Map open IDs to metadata and sort: pinned first, then preserve user's tab order
  const openConversations = useMemo(() => {
    const pinnedChats: ConversationMeta[] = []
    const unpinnedChats: ConversationMeta[] = []

    // Separate pinned and unpinned while preserving order
    openConversationIds.forEach((id) => {
      const chat = allConversationsById.get(id)
      if (!chat) return

      if (pinnedConversationIds.includes(id)) {
        pinnedChats.push(chat)
      } else {
        unpinnedChats.push(chat)
      }
    })

    // Sort pinned by recency (most recent first)
    pinnedChats.sort((a, b) => {
      const aT = new Date(a.updated_at || a.created_at || "0").getTime()
      const bT = new Date(b.updated_at || b.created_at || "0").getTime()
      return bT - aT
    })

    // Unpinned maintain their order from openConversationIds (user's tab order)
    const result = [...pinnedChats, ...unpinnedChats]

    // Keep split tabs adjacent when split is active.
    if (splitPaneIds.length >= 2) {
      const splitIdsSet = new Set(splitPaneIds)
      const firstSplitIdx = result.findIndex((chat) => splitIdsSet.has(chat.id))
      if (firstSplitIdx >= 0) {
        const splitChats = result
          .filter((chat) => splitIdsSet.has(chat.id))
          .sort((a, b) => splitPaneIds.indexOf(a.id) - splitPaneIds.indexOf(b.id))
        const nonSplitChats = result.filter((chat) => !splitIdsSet.has(chat.id))
        const insertAt = Math.min(firstSplitIdx, nonSplitChats.length)
        return [
          ...nonSplitChats.slice(0, insertAt),
          ...splitChats,
          ...nonSplitChats.slice(insertAt),
        ]
      }
    }

    return result
  }, [openConversationIds, allConversationsById, pinnedConversationIds, splitPaneIds])
  const splitPaneIdSet = useMemo(() => new Set(splitPaneIds), [splitPaneIds])

  const onSwitch = useCallback(
    (conversationId: string) => {
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
    },
    [setConversationUnseenChanges],
  )

  const onSwitchFromHistory = useCallback((conversationId: string) => {
    const state = useAgentConversationStore.getState()
    const isAlreadyOpen = state.openConversationIds.includes(conversationId)

    if (!isAlreadyOpen) {
      state.addToOpenConversations(conversationId)
    }
    state.setActiveConversation(conversationId)
  }, [])

  const onCloseTab = useCallback((conversationId: string) => {
    useAgentConversationStore.getState().removeFromOpenConversations(conversationId)
  }, [])

  const onCloseOtherTabs = useCallback((conversationId: string) => {
    const state = useAgentConversationStore.getState()
    const idsToClose = state.openConversationIds.filter((id) => id !== conversationId)
    idsToClose.forEach((id) => state.removeFromOpenConversations(id))
    state.setActiveConversation(conversationId)
  }, [])

  const onCloseTabsToRight = useCallback(
    (conversationId: string, visualIndex: number) => {
      const state = useAgentConversationStore.getState()

      // Use visual order from sorted openConversations, not storage order
      const idsToClose = openConversations.slice(visualIndex + 1).map((sc) => sc.id)
      idsToClose.forEach((id) => state.removeFromOpenConversations(id))
    },
    [openConversations],
  )

  const [editingConversationId, setEditingConversationId] = useState<string | null>(null)
  const [editName, setEditName] = useState("")
  const [editLoading, setEditLoading] = useState(false)

  const renameMutation = api.agents.renameConversation.useMutation({
    onSuccess: (_, variables) => {
      // Update local store
      useAgentConversationStore
        .getState()
        .updateConversationName(variables.conversationId, variables.title)
    },
    onError: (error) => {
      // Show helpful error message (like Canvas)
      if (error.data?.code === "NOT_FOUND") {
        toast.error("Send a message first before renaming this chat")
      } else {
        toast.error("Failed to rename chat")
      }
    },
  })

  const handleRenameClick = useCallback((conversation?: ConversationMeta) => {
    // Allow rename attempt, will show toast if not in DB yet (like Canvas)
    setEditingConversationId(conversation?.id ?? null)
    setEditName(conversation?.name || "")
  }, [])

  const handleEditSave = useCallback(
    async (conversation?: ConversationMeta) => {
      if (!conversation?.id) return
      const trimmedName = editName.trim()

      // If name hasn't changed, just exit editing mode
      if (trimmedName === conversation?.name) {
        setEditingConversationId(null)
        return
      }

      if (!trimmedName) {
        // Reset to original name if empty
        setEditName(conversation?.name || "")
        setEditingConversationId(null)
        return
      }

      // Store old name for revert on error (like Canvas)
      const oldName = conversation?.name

      // Optimistic update
      useAgentConversationStore.getState().updateConversationName(conversation.id, trimmedName)

      setEditLoading(true)
      setEditingConversationId(null)
      setEditName("")

      try {
        await renameMutation.mutateAsync({
          conversationId: conversation.id,
          title: trimmedName,
        })
      } catch {
        // Revert on error (like Canvas)
        useAgentConversationStore
          .getState()
          .updateConversationName(conversation.id, oldName || "New Chat")
      } finally {
        setEditLoading(false)
      }
    },
    [editName, renameMutation],
  )

  const handleEditCancel = useCallback((conversation?: ConversationMeta) => {
    setEditName(conversation?.name || "")
    setEditingConversationId(null)
  }, [])

  const handleSelectFromHistory = useCallback(
    (conversation?: ConversationMeta) => {
      if (conversation?.id) {
        onSwitchFromHistory(conversation.id)
      }
    },
    [onSwitchFromHistory],
  )

  // Hotkey: / to open history popover when sidebar is closed (tabs mode)
  useEffect(() => {
    const handleHistoryHotkey = (e: KeyboardEvent) => {
      // Only in tabs mode (sidebar closed)
      if (conversationsSidebarMode !== "tabs") return

      if (
        e.key === "/" &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.shiftKey
      ) {
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
        searchHistoryPopoverRef.current?.open()
      }
    }

    window.addEventListener("keydown", handleHistoryHotkey, true)
    return () =>
      window.removeEventListener("keydown", handleHistoryHotkey, true)
  }, [conversationsSidebarMode])

  // Keyboard shortcut: Cmd+Shift+T / Ctrl+Shift+T for new conversation
  // Scroll to active tab when it changes
  useEffect(() => {
    if (!activeConversationId || !tabsContainerRef.current) return

    const container = tabsContainerRef.current
    const activeTabElement = tabRefs.current.get(activeConversationId)

    if (activeTabElement) {
      setTimeout(() => {
        const containerRect = container.getBoundingClientRect()
        const tabRect = activeTabElement.getBoundingClientRect()

        const isTabLeftOfView = tabRect.left < containerRect.left
        const isTabRightOfView = tabRect.right > containerRect.right

        if (isTabLeftOfView || isTabRightOfView) {
          const tabCenter =
            activeTabElement.offsetLeft + activeTabElement.offsetWidth / 2
          const containerCenter = container.offsetWidth / 2
          const targetScroll = tabCenter - containerCenter
          const maxScroll = container.scrollWidth - container.offsetWidth
          const clampedScroll = Math.max(0, Math.min(targetScroll, maxScroll))

          container.scrollTo({
            left: clampedScroll,
            behavior: "smooth",
          })
        }
      }, 0)
    }
  }, [activeConversationId, openConversations])

  // Check if text is truncated for each tab - updates ref and DOM directly
  useEffect(() => {
    const checkTruncation = () => {
      const newTruncated = new Set<string>()
      textRefs.current.forEach((el, conversationId) => {
        if (el && el.scrollWidth > el.clientWidth) {
          newTruncated.add(conversationId)
        }
      })
      truncatedTabsRef.current = newTruncated

      // Update gradient visibility for each tab via DOM
      tabRefs.current.forEach((tabEl, conversationId) => {
        const gradientEl = tabEl.querySelector('[data-truncate-gradient]') as HTMLElement
        if (gradientEl) {
          gradientEl.style.display = newTruncated.has(conversationId) ? 'block' : 'none'
        }
      })
    }

    checkTruncation()

    const resizeObserver = new ResizeObserver(() => checkTruncation())
    textRefs.current.forEach((el) => el && resizeObserver.observe(el))

    return () => resizeObserver.disconnect()
  }, [openConversations, activeConversationId])

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

  const hasNoChats = openConversations.length === 0
  const hasSingleChat = openConversations.length === 1

  // Check scroll position for gradients - uses direct DOM manipulation
  const checkScrollPosition = useCallback(() => {
    const container = tabsContainerRef.current
    if (!container) return

    const { scrollLeft, scrollWidth, clientWidth } = container
    const isScrollable = scrollWidth > clientWidth

    const showLeft = isScrollable && scrollLeft > 0
    const showRight = isScrollable && scrollLeft < scrollWidth - clientWidth - 1

    if (leftGradientRef.current) {
      leftGradientRef.current.style.display = showLeft ? "block" : "none"
    }
    if (rightGradientRef.current) {
      rightGradientRef.current.style.display = showRight ? "block" : "none"
    }
  }, [])

  // Update gradients on scroll
  useEffect(() => {
    const container = tabsContainerRef.current
    if (!container) return

    checkScrollPosition()

    container.addEventListener("scroll", checkScrollPosition, { passive: true })
    return () => container.removeEventListener("scroll", checkScrollPosition)
  }, [checkScrollPosition])

  // Update gradients when tabs change
  useEffect(() => {
    checkScrollPosition()
  }, [openConversations, checkScrollPosition])

  // Update gradients on window resize
  useEffect(() => {
    const handleResize = () => checkScrollPosition()
    window.addEventListener("resize", handleResize)
    return () => window.removeEventListener("resize", handleResize)
  }, [checkScrollPosition])

  // Cleanup refs for closed tabs to prevent memory leaks
  useEffect(() => {
    const openIds = new Set(openConversationIds)

    // Remove refs for tabs that are no longer open
    tabRefs.current.forEach((_, id) => {
      if (!openIds.has(id)) {
        tabRefs.current.delete(id)
        textRefs.current.delete(id)
      }
    })
  }, [openConversationIds])

  return (
    <div
      className="flex items-center gap-1 h-7 w-full"
      style={{
        // @ts-expect-error - WebKit-specific property for Electron window dragging
        WebkitAppRegion: "drag",
      }}
    >
      {/* Burger button - hidden when conversations sidebar is open (it moves into sidebar) */}
      {onBackToChats && conversationsSidebarMode === "tabs" && (
        <Button
          variant="ghost"
          size="icon"
          onClick={onBackToChats}
          className="h-6 w-6 p-0 hover:bg-foreground/10 transition-[background-color,transform] duration-150 ease-out active:scale-[0.97] flex-shrink-0 rounded-md"
          aria-label="Back to chats"
          style={{
            // @ts-expect-error - WebKit-specific property
            WebkitAppRegion: "no-drag",
          }}
        >
          <AlignJustify className="h-4 w-4" />
          <span className="sr-only">Back to chats</span>
        </Button>
      )}

      {/* Open sidebar button - only on desktop when in tabs mode */}
      {!isMobile && conversationsSidebarMode === "tabs" && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setConversationsSidebarMode("sidebar")}
              className="h-6 w-6 p-0 hover:bg-foreground/10 transition-[background-color,transform] duration-150 ease-out active:scale-[0.97] flex-shrink-0 rounded-md flex items-center justify-center"
              style={{
                // @ts-expect-error - WebKit-specific property
                WebkitAppRegion: "no-drag",
              }}
            >
              <IconOpenSidebarRight className="h-4 w-4 scale-x-[-1]" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Open chats pane</TooltipContent>
        </Tooltip>
      )}

      <div
        className="relative flex-1 min-w-0 flex items-center"
        style={{
          // @ts-expect-error - WebKit-specific property
          WebkitAppRegion: "no-drag",
        }}
      >
        {/* Left gradient - visibility controlled via ref */}
        <div
          ref={leftGradientRef}
          className="absolute left-0 top-0 bottom-0 w-8 bg-gradient-to-r from-background to-transparent pointer-events-none z-30"
          style={{ display: "none" }}
        />

        {/* Scrollable tabs container - with padding-right for plus button */}
        <div
          ref={tabsContainerRef}
          className={cn(
            "flex items-center px-1 py-1 -my-1 gap-1 flex-1 min-w-0 overflow-x-auto scrollbar-hide pr-12",
            // Hide tabs when sidebar is open (desktop) or when only one chat exists
            (conversationsSidebarMode === "sidebar" && !isMobile) && "hidden",
            hasSingleChat && "invisible",
          )}
        >
          {hasNoChats
            ? null
            : openConversations.map((conversation, index) => {
                const isActive = activeConversationId === conversation?.id
                const isInSplitPair = splitPaneIdSet.has(conversation?.id)
                const hasSplitPrev = index > 0 && splitPaneIdSet.has(openConversations[index - 1]?.id)
                const hasSplitNext = index < openConversations.length - 1 && splitPaneIdSet.has(openConversations[index + 1]?.id)
                const isLoading = loadingConversations.has(conversation?.id || "")
                const hasUnseen = conversationsUnseenChanges.has(conversation?.id || "")
                const hasTabsToRight = index < openConversations.length - 1
                const isPinned = pinnedConversationIds.includes(conversation?.id)
                // Get mode from conversation itself (defaults to "agent")
                const mode = conversation?.mode || "agent"
                // Check if this chat is waiting for user answer
                const hasPendingQuestion = pendingQuestionsMap.has(conversation?.id || "")
                // Check if this chat has a pending plan approval
                const hasPendingPlan = pendingPlanApprovals.has(conversation?.id || "")

                return (
                  <ContextMenu key={conversation?.id}>
                    <ContextMenuTrigger asChild>
                      <button
                        ref={(el) => {
                          if (el) {
                            tabRefs.current.set(conversation?.id, el)
                          } else {
                            tabRefs.current.delete(conversation?.id)
                          }
                        }}
                        onClick={(e) => {
                          e.stopPropagation()
                          e.preventDefault()
                          if (editingConversationId !== conversation?.id) {
                            onSwitch(conversation?.id)
                          }
                        }}
                        onMouseDown={(e) => {
                          // Middle-click to close tab (like Chrome)
                          if (e.button === 1 && openConversations.length > 1) {
                            e.preventDefault()
                            e.stopPropagation()
                            onCloseTab(conversation?.id)
                          }
                        }}
                        onAuxClick={(e) => {
                          // Prevent context menu on middle-click
                          if (e.button === 1) {
                            e.preventDefault()
                            e.stopPropagation()
                          }
                        }}
                        onDoubleClick={(e) => {
                          e.stopPropagation()
                          e.preventDefault()
                          if (editingConversationId !== conversation?.id) {
                            handleRenameClick(conversation)
                          }
                        }}
                        className={cn(
                          "group relative flex items-center text-sm rounded-md transition-colors duration-75 cursor-pointer h-6 flex-shrink-0",
                          "outline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring/70",
                          editingConversationId === conversation?.id
                            ? "overflow-visible px-0"
                            : "overflow-hidden px-1.5 py-0.5 whitespace-nowrap min-w-[50px] gap-1.5",
                          isActive
                            ? "bg-muted text-foreground max-w-[180px]"
                            : "hover:bg-muted/80 max-w-[150px]",
                          isInSplitPair && "border border-border/60",
                          isInSplitPair && !isActive && "bg-muted/40 hover:bg-muted/60",
                          isInSplitPair && hasSplitPrev && "-ml-1 rounded-l-none",
                          isInSplitPair && hasSplitNext && "rounded-r-none",
                        )}
                      >
                        {/* Icon: question icon (priority) OR loading spinner OR mode icon with badge (hide when editing) */}
                        {editingConversationId !== conversation?.id && (
                          <div className="flex-shrink-0 w-3.5 h-3.5 flex items-center justify-center relative">
                            {hasPendingQuestion ? (
                              // Waiting for user answer: show question icon (highest priority)
                              <QuestionIcon className="w-3.5 h-3.5 text-blue-500" />
                            ) : isLoading ? (
                              // Loading: show spinner
                              <IconSpinner className="w-3.5 h-3.5 text-muted-foreground" />
                            ) : (
                              <>
                                {/* Main mode icon */}
                                {mode === "plan" ? (
                                  <PlanIcon className="w-3.5 h-3.5 text-muted-foreground" />
                                ) : (
                                  <AgentIcon className="w-3.5 h-3.5 text-muted-foreground" />
                                )}
                                {/* Badge in bottom-right corner: amber dot (plan) > unseen dot > pin icon */}
                                {(hasPendingPlan || hasUnseen || isPinned) && (
                                  <div
                                    className={cn(
                                      "absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full flex items-center justify-center",
                                      isActive ? "bg-muted" : "bg-background",
                                    )}
                                  >
                                    {hasPendingPlan ? (
                                      <div className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                                    ) : hasUnseen ? (
                                      <div className="w-1.5 h-1.5 rounded-full bg-[#307BD0]" />
                                    ) : isPinned ? (
                                      <PinFilledIcon className="w-2 h-2 text-muted-foreground" />
                                    ) : null}
                                  </div>
                                )}
                              </>
                            )}
                          </div>
                        )}

                        {editingConversationId === conversation?.id ? (
                          <InlineEdit
                            value={editName}
                            onChange={setEditName}
                            onSave={() => handleEditSave(conversation)}
                            onCancel={() => handleEditCancel(conversation)}
                            isEditing={true}
                            disabled={editLoading}
                            className="text-sm !px-1 !py-0 !h-6 min-w-[100px] border border-input rounded-md !ring-0 !shadow-none focus-visible:!ring-0 focus-visible:!ring-offset-0 focus-visible:!border-input"
                          />
                        ) : (
                          <span
                            ref={(el) => {
                              if (el) {
                                textRefs.current.set(conversation?.id, el)
                              } else {
                                textRefs.current.delete(conversation?.id)
                              }
                            }}
                            className="relative z-0 text-left flex-1 min-w-0 pr-1 overflow-hidden block whitespace-nowrap"
                          >
                            {conversation?.name || "New Chat"}
                          </span>
                        )}

                        {/* Gradient fade on the right when text is truncated and not editing - visibility controlled via DOM */}
                        {editingConversationId !== conversation?.id && (
                          <div
                            data-truncate-gradient
                            className={cn(
                              "absolute right-0 top-0 bottom-0 w-6 pointer-events-none z-[1] rounded-r-md opacity-100 group-hover:opacity-0 transition-opacity duration-200",
                              isActive
                                ? "bg-gradient-to-l from-muted to-transparent"
                                : "bg-gradient-to-l from-background to-transparent",
                            )}
                            style={{ display: truncatedTabsRef.current.has(conversation?.id) ? "block" : "none" }}
                          />
                        )}

                        {/* Close button - only show when hovered and multiple tabs and not editing */}
                        {openConversations.length > 1 &&
                          editingConversationId !== conversation?.id && (
                            <div className="absolute right-0 top-0 bottom-0 flex items-center justify-end pr-1 opacity-0 group-hover:opacity-100 transition-opacity duration-200 z-10">
                              <div
                                className={cn(
                                  "absolute right-0 top-0 bottom-0 w-9 flex items-center justify-center rounded-r-md",
                                  isActive
                                    ? "bg-[linear-gradient(to_left,hsl(var(--muted))_0%,hsl(var(--muted))_60%,transparent_100%)]"
                                    : "bg-[linear-gradient(to_left,color-mix(in_srgb,hsl(var(--muted))_80%,hsl(var(--background)))_0%,color-mix(in_srgb,hsl(var(--muted))_80%,hsl(var(--background)))_60%,transparent_100%)]",
                                )}
                              />
                              <span
                                role="button"
                                tabIndex={-1}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  onCloseTab(conversation?.id)
                                }}
                                className="relative z-20 hover:text-foreground rounded p-0.5 transition-[color,transform] duration-150 ease-out active:scale-[0.97] cursor-pointer"
                                title={
                                  isActive && archiveAgentHotkey
                                    ? `Close tab (${archiveAgentHotkey})`
                                    : "Close tab"
                                }
                              >
                                <X className="h-3 w-3" />
                              </span>
                            </div>
                          )}
                      </button>
                    </ContextMenuTrigger>
                    <ConversationContextMenu
                      conversation={conversation}
                      isPinned={isPinned}
                      onTogglePin={togglePinConversation}
                      onRename={handleRenameClick}
                      onArchive={onCloseTab}
                      onArchiveOthers={onCloseOtherTabs}
                      isOnlyChat={openConversations.length === 1}
                      showCloseTabOptions={true}
                      onCloseTab={onCloseTab}
                      onCloseOtherTabs={onCloseOtherTabs}
                      onCloseTabsToRight={onCloseTabsToRight}
                      visualIndex={index}
                      hasTabsToRight={hasTabsToRight}
                      canCloseOtherTabs={openConversations.length > 2}
                      chatId={parentChatId}
                      onOpenInSplit={addToSplit}
                      onCloseSplit={closeSplit}
                      onRemoveFromSplit={removeFromSplit}
                      splitPaneCount={splitPaneIds.length}
                      isActiveTab={isActive}
                      isSplitTab={isInSplitPair}
                    />
                  </ContextMenu>
                )
              })}
        </div>

        {/* Plus button - absolute positioned on right with gradient cover */}
        {(isMobile || (!isMobile && conversationsSidebarMode === "tabs")) && (
          <div className="absolute right-0 top-0 bottom-0 flex items-center z-20">
            {/* Gradient to cover content peeking from the left */}
            <div className="w-6 h-full bg-gradient-to-r from-transparent to-background" />
            <div className="h-full flex items-center bg-background pr-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={onCreateNew}
                    className="h-6 w-6 p-0 hover:bg-foreground/10 transition-[background-color,transform] duration-150 ease-out active:scale-[0.97] rounded-md"
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  New chat
                  {newAgentHotkey && <Kbd>{newAgentHotkey}</Kbd>}
                </TooltipContent>
              </Tooltip>
            </div>
          </div>
        )}
      </div>

      {/* Action buttons - always visible on mobile, on desktop only in tabs mode */}
      {(isMobile || (!isMobile && conversationsSidebarMode === "tabs")) && (
        <div
          className="flex items-center gap-1"
          style={{
            // @ts-expect-error - WebKit-specific property
            WebkitAppRegion: "no-drag",
          }}
        >
          <SearchHistoryPopover
            ref={searchHistoryPopoverRef}
            sortedConversations={sortedConversations}
            loadingConversations={loadingConversations}
            conversationsUnseenChanges={conversationsUnseenChanges}
            pendingQuestionsMap={pendingQuestionsMap}
            pendingPlanApprovals={pendingPlanApprovals}
            allConversationsLength={allConversations.length}
            onSelect={handleSelectFromHistory}
          />
        </div>
      )}

      {/* Diff button - visible on desktop when unified sidebar is disabled OR diff widget is hidden */}
      {/* Only show if onOpenDiff is provided (clickable action available) */}
      {!isMobile && canOpenDiff && showDiffButton && onOpenDiff && (
        <div
          className="rounded-md bg-background/10 backdrop-blur-[10px] flex items-center justify-center"
          style={{
            // @ts-expect-error - WebKit-specific property
            WebkitAppRegion: "no-drag",
          }}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => onOpenDiff?.()}
                className="h-6 w-6 p-0 transition-[background-color,transform] duration-150 ease-out active:scale-[0.97] flex-shrink-0 rounded-md flex items-center justify-center hover:bg-foreground/10"
              >
                <DiffIcon className="h-4 w-4" />
                <span className="sr-only">Open diff</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <span>View changes</span>
              {openDiffHotkey && <Kbd>{openDiffHotkey}</Kbd>}
            </TooltipContent>
          </Tooltip>
        </div>
      )}

      {/* Terminal button - visible on desktop when unified sidebar is disabled OR terminal widget is hidden, and terminal is not already open */}
      {!isMobile && canOpenTerminal && showTerminalButton && !isTerminalOpen && (
        <div
          className="rounded-md bg-background/10 backdrop-blur-[10px] flex items-center justify-center"
          style={{
            // @ts-expect-error - WebKit-specific property
            WebkitAppRegion: "no-drag",
          }}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => onOpenTerminal?.()}
                className="h-6 w-6 p-0 transition-[background-color,transform] duration-150 ease-out active:scale-[0.97] flex-shrink-0 rounded-md flex items-center justify-center hover:bg-foreground/10"
              >
                <TerminalSquare className="h-4 w-4" />
                <span className="sr-only">Open terminal</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <span>Open terminal</span>
              {toggleTerminalHotkey && <Kbd>{toggleTerminalHotkey}</Kbd>}
            </TooltipContent>
          </Tooltip>
        </div>
      )}

      {/* Diff button - only on mobile when diff is available */}
      {isMobile && onOpenDiff && canOpenDiff && (
        <div
          className="rounded-md bg-background/10 backdrop-blur-[10px] flex items-center justify-center"
          style={{
            // @ts-expect-error - WebKit-specific property
            WebkitAppRegion: "no-drag",
          }}
        >
          <Button
            variant="ghost"
            size="icon"
            onClick={onOpenDiff}
            className="h-7 w-7 p-0 hover:bg-foreground/10 transition-[background-color,transform] duration-150 ease-out active:scale-[0.97] flex-shrink-0 flex items-center justify-center"
          >
            <DiffIcon className="h-4 w-4" />
            <span className="sr-only">Open diff</span>
          </Button>
        </div>
      )}

      {/* Play button - only on mobile when preview is available */}
      {isMobile && onOpenPreview && canOpenPreview && (
        <div
          className="rounded-md bg-background/10 backdrop-blur-[10px] flex items-center justify-center"
          style={{
            // @ts-expect-error - WebKit-specific property
            WebkitAppRegion: "no-drag",
          }}
        >
          <Button
            variant="ghost"
            size="icon"
            onClick={onOpenPreview}
            className="h-7 w-7 p-0 hover:bg-foreground/10 transition-[background-color,transform] duration-150 ease-out active:scale-[0.97] flex-shrink-0 flex items-center justify-center"
          >
            <Play className="h-4 w-4" />
            <span className="sr-only">Open preview</span>
          </Button>
        </div>
      )}

    </div>
  )
}
