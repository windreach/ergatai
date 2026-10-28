"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useAtom, useAtomValue, useSetAtom } from "jotai"
// import { useSearchParams, useRouter } from "next/navigation" // Desktop doesn't use next/navigation
// TODO(ergatai#1201): Implement desktop navigation state management
// Desktop doesn't use next/navigation, so we mock these hooks.
// URL synchronization is disabled in desktop builds.
// Tracking issue: https://github.com/ergatai/ergatai/issues/1201
const useSearchParams = () => ({ get: (_key: string) => null })
const useRouter = () => ({
  push: (_path: string) => {},
  replace: (_path: string, _options?: { scroll?: boolean }) => {},
})
// TODO(ergatai#1202): Implement desktop auth system
// Desktop doesn't use Clerk, so we mock these hooks.
// User/authentication features are disabled in desktop builds.
// Tracking issue: https://github.com/ergatai/ergatai/issues/1202
const useUser = () => ({ user: null })
const useClerk = () => ({ signOut: () => {} })
import {
  selectedAgentChatIdAtom,
  previousAgentChatIdAtom,
  selectedDraftIdAtom,
  showNewChatFormAtom,
  agentsMobileViewModeAtom,
  agentsPreviewSidebarOpenAtom,
  agentsSidebarOpenAtom,
  agentsConversationsSidebarModeAtom,
  agentsConversationsSidebarWidthAtom,
  desktopViewAtom,
  selectedWorkspaceIdAtom,
  selectedWorkspaceAtom,
} from "../atoms"
import {
  billingMethodAtom,
  anthropicOnboardingCompletedAtom,
  apiKeyOnboardingCompletedAtom,
  agentsQuickSwitchOpenAtom,
  agentsQuickSwitchSelectedIndexAtom,
  conversationsQuickSwitchOpenAtom,
  conversationsQuickSwitchSelectedIndexAtom,
  ctrlTabTargetAtom,
} from "../../../lib/atoms"
import { NewChatForm } from "../main/new-chat-form"
import { AgentsDefaultView } from "./agents-default-view"
import { TaskBoardView } from "../../task-board/task-board-view"
import { AddAgentViewPage } from "../components/add-agent-view"
import { ChatView } from "../main/active-chat"
import { api } from "../../../lib/api-adapter"
import { trpc } from "../../../lib/trpc"
import { useIsMobile } from "../../../lib/hooks/use-mobile"
import { AgentsSidebar } from "../../sidebar/agents-sidebar"
import { AgentsConversationsSidebar } from "../../sidebar/agents-conversations-sidebar"
import { AgentPreview } from "./agent-preview"
import { AgentDiffView } from "./agent-diff-view"
import { TerminalSidebar, terminalSidebarOpenAtomFamily } from "../../terminal"
import { getTerminalScopeKey } from "../../terminal/utils"
import {
  useAgentConversationStore,
  type ConversationMeta,
} from "../stores/conversation-store"
import { useShallow } from "zustand/react/shallow"
import { motion, AnimatePresence } from "motion/react"
// import { ResizableSidebar } from "@/app/(alpha)/canvas/[id]/{components}/resizable-sidebar"
import { ResizableSidebar } from "../../../components/ui/resizable-sidebar"
// import { useClerk, useUser } from "@clerk/nextjs"
// import { useCombinedAuth } from "@/lib/hooks/use-combined-auth"
// TODO(ergatai#1202): Replace with real desktop auth hook
// Desktop mock — returns null userId, disabling user-specific features.
const useCombinedAuth = () => ({ userId: null })
import { Button } from "../../../components/ui/button"
import { AlignJustify } from "lucide-react"
import { AgentsQuickSwitchDialog } from "../components/agents-quick-switch-dialog"
import { ConversationsQuickSwitchDialog } from "../components/conversations-quick-switch-dialog"
import { isDesktopApp } from "../../../lib/utils/platform"
import { SettingsContent } from "../../settings/settings-content"
import { useCollaborationMode } from "../collaboration/use-collaboration-mode"
// TODO(ergatai#1203): Implement real admin role check for desktop
// Desktop mock — always returns false, hiding admin-only UI in production.
// In DEV mode, the sandbox debugger is shown via `import.meta.env.DEV` fallback.
const useIsAdmin = () => false

// Main Component
export function AgentsContent() {
  const [selectedChatId, setSelectedChatId] = useAtom(selectedAgentChatIdAtom)
  const desktopView = useAtomValue(desktopViewAtom)
  const setDesktopView = useSetAtom(desktopViewAtom)
  const { mode: collaborationMode } = useCollaborationMode()
  const [selectedDraftId, setSelectedDraftId] = useAtom(selectedDraftIdAtom)
  const [showNewChatForm, setShowNewChatForm] = useAtom(showNewChatFormAtom)
  const setBillingMethod = useSetAtom(billingMethodAtom)
  const setAnthropicOnboardingCompleted = useSetAtom(
    anthropicOnboardingCompletedAtom,
  )
  const setApiKeyOnboardingCompleted = useSetAtom(apiKeyOnboardingCompletedAtom)
  const [sidebarOpen, setSidebarOpen] = useAtom(agentsSidebarOpenAtom)
  const [previewSidebarOpen, setPreviewSidebarOpen] = useAtom(
    agentsPreviewSidebarOpenAtom,
  )
  const [mobileViewMode, setMobileViewMode] = useAtom(agentsMobileViewModeAtom)
  const [conversationsSidebarMode, setConversationsSidebarMode] = useAtom(
    agentsConversationsSidebarModeAtom,
  )
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useAtom(selectedWorkspaceIdAtom)
  const [selectedProjectEntry] = useAtom(selectedWorkspaceAtom)
  const { data: selectedWorkspace, error: workspaceError } = trpc.ergatai.getManagedWorkspace.useQuery(
    { id: selectedWorkspaceId! },
    { enabled: !!selectedWorkspaceId },
  )

  // Clear invalid workspace ID if workspace no longer exists (returns null for 404)
  useEffect(() => {
    if ((workspaceError || selectedWorkspace === null) && selectedWorkspaceId) {
      console.warn("[Workspace] Selected workspace no longer exists, clearing selection:", selectedWorkspaceId)
      setSelectedWorkspaceId(null)
    }
  }, [workspaceError, selectedWorkspace, selectedWorkspaceId, setSelectedWorkspaceId])

  // Per-chat terminal sidebar state
  const terminalSidebarAtom = useMemo(
    () => terminalSidebarOpenAtomFamily(selectedChatId || ""),
    [selectedChatId],
  )
  const setTerminalSidebarOpen = useSetAtom(terminalSidebarAtom)

  useEffect(() => {
    if (!selectedChatId) {
      useAgentConversationStore.getState().setChatId(null)
    }
  }, [selectedChatId])

  useEffect(() => {
    if (collaborationMode !== "group") return

    setDesktopView(null)
    setSelectedDraftId(null)
    setShowNewChatForm(false)
    setMobileViewMode("chat")
  }, [
    collaborationMode,
    setDesktopView,
    setMobileViewMode,
    setSelectedDraftId,
    setShowNewChatForm,
  ])

  const hasOpenedConversationsSidebar = useRef(false)
  const wasConversationsSidebarOpen = useRef(false)
  const [shouldAnimateConversationsSidebar, setShouldAnimateConversationsSidebar] =
    useState(conversationsSidebarMode !== "sidebar")
  const searchParams = useSearchParams()
  const router = useRouter()
  const isInitialized = useRef(false)
  const isFirstRenderRef = useRef(true) // Skip URL sync on first render to avoid race condition
  const isNavigatingRef = useRef(false)
  const newChatFormKeyRef = useRef(0)
  const isMobile = useIsMobile()
  const [isHydrated, setIsHydrated] = useState(false)
  const { userId } = useCombinedAuth()
  const { user } = useUser()
  const { signOut } = useClerk()
  const isAdmin = useIsAdmin()

  // Quick-switch dialog state - Agents (Opt+Ctrl+Tab)
  const [quickSwitchOpen, setQuickSwitchOpen] = useAtom(
    agentsQuickSwitchOpenAtom,
  )
  const [quickSwitchSelectedIndex, setQuickSwitchSelectedIndex] = useAtom(
    agentsQuickSwitchSelectedIndexAtom,
  )
  const holdTimerRef = useRef<NodeJS.Timeout | null>(null)
  const modifierKeysHeldRef = useRef(false)
  const wasShiftPressedRef = useRef(false)
  const isQuickSwitchingRef = useRef(false)
  const frozenRecentChatsRef = useRef<typeof agentChats>([]) // Frozen snapshot for dialog

  // Ctrl+Tab target preference
  const ctrlTabTarget = useAtomValue(ctrlTabTargetAtom)

  // Quick-switch dialog state - Conversations (Ctrl+Tab)
  const [conversationQuickSwitchOpen, setConversationQuickSwitchOpen] = useAtom(
    conversationsQuickSwitchOpenAtom,
  )
  const [conversationQuickSwitchSelectedIndex, setConversationQuickSwitchSelectedIndex] =
    useAtom(conversationsQuickSwitchSelectedIndexAtom)
  const conversationHoldTimerRef = useRef<NodeJS.Timeout | null>(null)
  const conversationModifierKeysHeldRef = useRef(false)
  const conversationWasShiftPressedRef = useRef(false)
  const frozenConversationsRef = useRef<ConversationMeta[]>([])
  // Refs to avoid effect re-running when dialog state changes (prevents keyup event loss)
  const conversationQuickSwitchOpenRef = useRef(conversationQuickSwitchOpen)
  const conversationQuickSwitchSelectedIndexRef = useRef(
    conversationQuickSwitchSelectedIndex,
  )
  conversationQuickSwitchOpenRef.current = conversationQuickSwitchOpen
  conversationQuickSwitchSelectedIndexRef.current = conversationQuickSwitchSelectedIndex

  // Get conversations from store with shallow comparison
  const { allConversations, openConversationIds, activeConversationId, setActiveConversation } = useAgentConversationStore(
    useShallow((state) => ({
      allConversations: state.allConversations,
      openConversationIds: state.openConversationIds,
      activeConversationId: state.activeConversationId,
      setActiveConversation: state.setActiveConversation,
    }))
  )

  // Update window title when active conversation changes
  const activeConversationName = useMemo(() => {
    if (!activeConversationId) return null
    const conversation = allConversations.find((sc) => sc.id === activeConversationId)
    return conversation?.name ?? null
  }, [activeConversationId, allConversations])

  useEffect(() => {
    if (typeof window !== "undefined" && window.desktopApi?.setWindowTitle) {
      window.desktopApi.setWindowTitle(activeConversationName || "")
    }
  }, [activeConversationName])

  // Fetch all projects for git info (like sidebar does)
  const { data: projects } = trpc.projects.list.useQuery(undefined, { staleTime: Infinity })

  // Fetch local chats for keyboard navigation and recent-chat switching
  const { data: localAgentChats } = trpc.chats.list.useQuery({})
  const agentChats = useMemo(
    () =>
      (localAgentChats ?? []).map((chat) => ({
        id: chat.id,
        name: chat.name,
        branch: chat.branch,
        updatedAt: chat.updatedAt,
        createdAt: chat.createdAt,
        projectId: null,
        worktreePath: chat.worktreePath,
        updated_at: chat.updatedAt ?? chat.createdAt ?? new Date(0),
        sandbox_id: null,
        meta: null,
      })),
    [localAgentChats],
  )

  // Create map for quick project lookup by id
  const projectsMap = useMemo(() => {
    if (!projects) return new Map()
    return new Map(projects.map((p) => [p.id, p]))
  }, [projects])

  // Fetch current chat data for preview info
  // Only fetch if selectedChatId looks like a valid chat ID (starts with "chat_")
  const isValidChatId = selectedChatId?.startsWith("chat_")
  const { data: chatData } = api.agents.getAgentChat.useQuery(
    { chatId: selectedChatId! },
    { enabled: !!isValidChatId },
  )

  useEffect(() => {
    if (!selectedChatId) return

    if (!selectedChatId.startsWith("chat_") || chatData === null) {
      setSelectedChatId(null)
    }
  }, [selectedChatId, chatData, setSelectedChatId])

  // Track previous chat ID for navigation after archive
  const [previousChatId, setPreviousChatId] = useAtom(previousAgentChatIdAtom)
  const prevSelectedChatIdRef = useRef<string | null>(null)

  // Update previousChatId when selectedChatId changes
  useEffect(() => {
    // Only update if we're switching from one chat to another
    if (prevSelectedChatIdRef.current && prevSelectedChatIdRef.current !== selectedChatId) {
      setPreviousChatId(prevSelectedChatIdRef.current)
    }
    prevSelectedChatIdRef.current = selectedChatId
  }, [selectedChatId, setPreviousChatId])

  // Note: Archive mutations moved to AgentsSidebar to share undo stack with Cmd+Z

  // Track hydration
  useEffect(() => {
    setIsHydrated(true)
  }, [])

  // On mount: read URL → set atom
  useEffect(() => {
    if (isInitialized.current) return
    isInitialized.current = true

    const chatIdFromUrl = searchParams.get("chat")
    if (chatIdFromUrl) {
      setSelectedChatId(chatIdFromUrl)
    }
  }, [searchParams, setSelectedChatId])

  // When atom changes: update URL and increment NewChatForm key when returning to new chat view
  useEffect(() => {
    // Skip the first render - let the URL read effect set the initial value first
    // This prevents a race condition where this effect would clear the chat param
    // before the atom has been updated from the URL
    if (isFirstRenderRef.current) {
      isFirstRenderRef.current = false
      return
    }

    const currentChatId = searchParams.get("chat")
    if (selectedChatId !== currentChatId) {
      const url = new URL(window.location.href)
      if (selectedChatId) {
        url.searchParams.set("chat", selectedChatId)
      } else {
        url.searchParams.delete("chat")
        // Increment key to force NewChatForm remount and trigger focus
        newChatFormKeyRef.current += 1
      }
      router.replace(url.pathname + url.search, { scroll: false })
    }
  }, [selectedChatId, searchParams, router])

  // Auto-close sidebars on mobile devices
  useEffect(() => {
    if (isMobile && isHydrated) {
      setSidebarOpen(false)
      setPreviewSidebarOpen(false)
    }
  }, [isMobile, isHydrated, setSidebarOpen, setPreviewSidebarOpen])

  // On mobile: when chat is selected, switch to chat mode
  useEffect(() => {
    if (isMobile && selectedChatId && mobileViewMode === "chats") {
      setMobileViewMode("chat")
    }
  }, [isMobile, selectedChatId, mobileViewMode, setMobileViewMode])

  // On mobile: when in terminal mode, sync with terminal sidebar close
  const terminalSidebarOpen = useAtomValue(terminalSidebarAtom)
  useEffect(() => {
    // If terminal sidebar closed while in terminal mode, go back to chat
    if (isMobile && mobileViewMode === "terminal" && !terminalSidebarOpen) {
      setMobileViewMode("chat")
    }
  }, [isMobile, mobileViewMode, terminalSidebarOpen, setMobileViewMode])

  // On mobile: show/hide native traffic lights based on view mode
  useEffect(() => {
    if (!isMobile) return
    if (
      typeof window === "undefined" ||
      !window.desktopApi?.setTrafficLightVisibility
    )
      return

    window.desktopApi.setTrafficLightVisibility(mobileViewMode === "chats")
  }, [isMobile, mobileViewMode])

  // Get recent chats for quick-switch dialog
  // Order: current chat first (left), then previous chats by last updated
  // IMPORTANT: Only recalculate when dialog is closed to prevent flickering
  const sortedChats = agentChats
    ? [...agentChats].sort(
        (a, b) =>
          new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
      )
    : []

  let recentChats: typeof sortedChats = []
  // Use frozen chats when dialog is open to prevent recalculation
  if (
    quickSwitchOpen &&
    frozenRecentChatsRef.current &&
    frozenRecentChatsRef.current.length > 0
  ) {
    recentChats = frozenRecentChatsRef.current ?? []
  } else if (selectedChatId) {
    // Put current chat first, then take next 4
    const currentChat = sortedChats.find((c) => c.id === selectedChatId)
    const otherChats = sortedChats
      .filter((c) => c.id !== selectedChatId)
      .slice(0, 4)
    recentChats = currentChat ? [currentChat, ...otherChats] : otherChats
  } else {
    recentChats = sortedChats.slice(0, 5)
  }

  // TODO(ergatai#1204): Extract duplicate keyboard handler logic into a custom hook
  // The workspace quick-switch (below) and agent/conversation quick-switch (further down)
  // share nearly identical hold-timer + frozen-snapshot + keyup navigation logic.
  // Consider extracting into `useQuickSwitchKeyboard({ items, onSelect, shortcut, ... })`.

  // Keyboard navigation: Quick switch between workspaces
  // Shortcut depends on ctrlTabTarget preference:
  // - "workspaces" (default): Ctrl+Tab switches workspaces
  // - "agents": Opt+Ctrl+Tab switches workspaces
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Determine shortcut based on preference
      const isCtrlTabOnly =
        e.ctrlKey && e.key === "Tab" && !e.altKey && !e.metaKey
      const isOptCtrlTab =
        e.altKey && e.ctrlKey && e.key === "Tab" && !e.metaKey

      // Workspace switch: Ctrl+Tab by default, or Opt+Ctrl+Tab when ctrlTabTarget is "agents"
      const isWorkspaceSwitchShortcut =
        ctrlTabTarget === "workspaces" ? isCtrlTabOnly : isOptCtrlTab

      if (isWorkspaceSwitchShortcut) {
        e.preventDefault()
        wasShiftPressedRef.current = e.shiftKey

        if (recentChats.length === 0) return

        // If dialog is open, navigate through chats
        if (quickSwitchOpen) {
          let nextIndex: number
          if (e.shiftKey) {
            // Shift + Tab = Previous
            nextIndex = quickSwitchSelectedIndex - 1
            if (nextIndex < 0) {
              nextIndex = (frozenRecentChatsRef.current?.length ?? 1) - 1
            }
          } else {
            // Tab = Next
            nextIndex =
              (quickSwitchSelectedIndex + 1) %
              (frozenRecentChatsRef.current?.length ?? 1)
          }
          setQuickSwitchSelectedIndex(nextIndex)
          return
        }

        // If dialog is not open yet, start hold timer
        if (!quickSwitchOpen && !holdTimerRef.current) {
          modifierKeysHeldRef.current = true

          // Freeze current recentChats snapshot for this dialog session
          frozenRecentChatsRef.current = [...recentChats]

          // Start timer to show dialog after 30ms (almost instant)
          holdTimerRef.current = setTimeout(() => {
            // Clear timer ref AFTER it fires - this is critical for close detection
            holdTimerRef.current = null
            if (modifierKeysHeldRef.current) {
              // Show dialog
              setQuickSwitchOpen(true)

              // Current chat is always at index 0 (left), select next chat (index 1)
              // For Shift+Tab, select last chat
              if (wasShiftPressedRef.current) {
                // Shift: go to last chat
                setQuickSwitchSelectedIndex(
                  (frozenRecentChatsRef.current?.length ?? 1) - 1,
                )
              } else {
                // Tab: go to next chat (index 1), or wrap to 0 if only one chat
                setQuickSwitchSelectedIndex(
                  (frozenRecentChatsRef.current?.length ?? 1) > 1 ? 1 : 0,
                )
              }
            }
          }, 30)

          return
        }
      }
    }

    const handleKeyUp = (e: KeyboardEvent) => {
      // ESC to close dialog without navigating
      if (e.key === "Escape" && quickSwitchOpen) {
        e.preventDefault()
        modifierKeysHeldRef.current = false
        isQuickSwitchingRef.current = false // Unblock selectedChatId changes

        if (holdTimerRef.current) {
          clearTimeout(holdTimerRef.current)
          holdTimerRef.current = null
        }

        setQuickSwitchOpen(false)
        setQuickSwitchSelectedIndex(0)
        return
      }

      // When modifier key is released
      // For workspaces mode (Ctrl+Tab only): react to Control release
      // For agents mode (Opt+Ctrl+Tab): react to Alt or Control release
      const isRelevantKeyRelease =
        ctrlTabTarget === "workspaces"
          ? e.key === "Control"
          : e.key === "Alt" || e.key === "Control"

      if (isRelevantKeyRelease) {
        modifierKeysHeldRef.current = false

        // If timer is still running (quick press - dialog not shown yet)
        if (holdTimerRef.current) {
          clearTimeout(holdTimerRef.current)
          holdTimerRef.current = null
          isQuickSwitchingRef.current = false // Unblock

          // Do quick switch without showing dialog
          if (!isNavigatingRef.current && agentChats && agentChats.length > 0) {
            // Get sorted chat list
            const sortedChats = [...agentChats].sort(
              (a, b) =>
                new Date(b.updated_at).getTime() -
                new Date(a.updated_at).getTime(),
            )
            isNavigatingRef.current = true
            setTimeout(() => {
              isNavigatingRef.current = false
            }, 300)

            // If no chat selected, select first one
            if (!selectedChatId) {
              setSelectedChatId(sortedChats[0].id)
              return
            }

            // Find current index
            const currentIndex = sortedChats.findIndex(
              (chat) => chat.id === selectedChatId,
            )

            if (currentIndex === -1) {
              setSelectedChatId(sortedChats[0].id)
              return
            }

            // Navigate forward or backward
            let nextIndex: number
            if (wasShiftPressedRef.current) {
              nextIndex = currentIndex - 1
              if (nextIndex < 0) {
                nextIndex = sortedChats.length - 1
              }
            } else {
              nextIndex = currentIndex + 1
              if (nextIndex >= sortedChats.length) {
                nextIndex = 0
              }
            }

            setSelectedChatId(sortedChats[nextIndex].id)
          }
          return
        }

        // If dialog is open, navigate to selected chat and close
        if (quickSwitchOpen) {
          const selectedChat =
            frozenRecentChatsRef.current?.[quickSwitchSelectedIndex]

          if (selectedChat) {
            setSelectedChatId(selectedChat.id)
          }

          setQuickSwitchOpen(false)
          setQuickSwitchSelectedIndex(0)
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    window.addEventListener("keyup", handleKeyUp)

    return () => {
      window.removeEventListener("keydown", handleKeyDown)
      window.removeEventListener("keyup", handleKeyUp)
      if (holdTimerRef.current) {
        clearTimeout(holdTimerRef.current)
      }
    }
  }, [
    agentChats,
    selectedChatId,
    setSelectedChatId,
    quickSwitchOpen,
    setQuickSwitchOpen,
    quickSwitchSelectedIndex,
    setQuickSwitchSelectedIndex,
    ctrlTabTarget,
    // Note: recentChats removed - we use frozenRecentChatsRef instead
  ])

  // Get open conversations for quick-switch (only tabs that are open in the selector)
  // Sorted by position in openConversationIds, with active first
  // Limited to 5 items for quick-switch dialog
  const recentConversations = useMemo(() => {
    if (!openConversationIds || openConversationIds.length === 0) return []

    // Get conversation metadata for open tabs
    const openConversations = openConversationIds
      .map((id) => allConversations.find((c) => c.id === id))
      .filter((c): c is ConversationMeta => c !== undefined)

    if (openConversations.length === 0) return []

    // Put active conversation first, keep rest in tab order, limit to 5
    if (activeConversationId) {
      const activeChat = openConversations.find((c) => c.id === activeConversationId)
      const otherChats = openConversations.filter((c) => c.id !== activeConversationId).slice(0, 4)
      return activeChat ? [activeChat, ...otherChats] : openConversations.slice(0, 5)
    }
    return openConversations.slice(0, 5)
  }, [openConversationIds, allConversations, activeConversationId])

  // Keyboard navigation: Quick switch between agents (conversations within workspace)
  // Shortcut depends on ctrlTabTarget preference:
  // - "workspaces" (default): Opt+Ctrl+Tab switches agents
  // - "agents": Ctrl+Tab switches agents
  // Uses refs for dialog state to avoid effect re-running and losing keyup events
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Determine shortcut based on preference
      const isCtrlTabOnly =
        e.ctrlKey && e.key === "Tab" && !e.altKey && !e.metaKey
      const isOptCtrlTab =
        e.altKey && e.ctrlKey && e.key === "Tab" && !e.metaKey

      // Agent switch: Opt+Ctrl+Tab by default, or Ctrl+Tab when ctrlTabTarget is "agents"
      const isAgentSwitchShortcut =
        ctrlTabTarget === "agents" ? isCtrlTabOnly : isOptCtrlTab

      if (isAgentSwitchShortcut) {
        e.preventDefault()
        conversationWasShiftPressedRef.current = e.shiftKey

        // If dialog is open, navigate through conversations
        if (conversationQuickSwitchOpenRef.current) {
          let nextIndex: number
          if (e.shiftKey) {
            nextIndex = conversationQuickSwitchSelectedIndexRef.current - 1
            if (nextIndex < 0) {
              nextIndex = (frozenConversationsRef.current?.length ?? 1) - 1
            }
          } else {
            nextIndex =
              (conversationQuickSwitchSelectedIndexRef.current + 1) %
              (frozenConversationsRef.current?.length ?? 1)
          }
          setConversationQuickSwitchSelectedIndex(nextIndex)
          return
        }

        // If dialog is not open yet, start hold timer
        if (
          !conversationQuickSwitchOpenRef.current &&
          !conversationHoldTimerRef.current
        ) {
          // Get fresh data from store for snapshot
          const store = useAgentConversationStore.getState()
          const currentOpenIds = store.openConversationIds
          const currentAllConversations = store.allConversations
          const currentActiveId = store.activeConversationId

          if (currentOpenIds.length === 0) return

          conversationModifierKeysHeldRef.current = true

          // Build frozen snapshot from current store state
          const openConversations = currentOpenIds
            .map((id) => currentAllConversations.find((c) => c.id === id))
            .filter((c): c is ConversationMeta => c !== undefined)

          if (openConversations.length === 0) return

          // Put active conversation first, limit to 5
          if (currentActiveId) {
            const activeChat = openConversations.find(
              (c) => c.id === currentActiveId,
            )
            const otherChats = openConversations.filter(
              (c) => c.id !== currentActiveId,
            ).slice(0, 4)
            frozenConversationsRef.current = activeChat
              ? [activeChat, ...otherChats]
              : openConversations.slice(0, 5)
          } else {
            frozenConversationsRef.current = openConversations.slice(0, 5)
          }

          conversationHoldTimerRef.current = setTimeout(() => {
            // Clear timer ref AFTER it fires - this is critical for close detection
            conversationHoldTimerRef.current = null
            if (conversationModifierKeysHeldRef.current) {
              // Update ref immediately so keyUp can detect dialog is open
              // (before React re-renders and updates the ref from state)
              conversationQuickSwitchOpenRef.current = true
              setConversationQuickSwitchOpen(true)
              if (conversationWasShiftPressedRef.current) {
                setConversationQuickSwitchSelectedIndex(
                  (frozenConversationsRef.current?.length ?? 1) - 1,
                )
              } else {
                setConversationQuickSwitchSelectedIndex(
                  (frozenConversationsRef.current?.length ?? 1) > 1 ? 1 : 0,
                )
              }
            }
          }, 30)

          return
        }
      }
    }

    const handleKeyUp = (e: KeyboardEvent) => {
      // ESC to close dialog without navigating
      if (e.key === "Escape" && conversationQuickSwitchOpenRef.current) {
        e.preventDefault()
        conversationModifierKeysHeldRef.current = false

        if (conversationHoldTimerRef.current) {
          clearTimeout(conversationHoldTimerRef.current)
          conversationHoldTimerRef.current = null
        }

        setConversationQuickSwitchOpen(false)
        setConversationQuickSwitchSelectedIndex(0)
        return
      }

      // When modifier key is released
      // For agents mode (Ctrl+Tab): react to Control release
      // For workspaces mode (Opt+Ctrl+Tab): react to Alt or Control release
      const isRelevantKeyRelease =
        ctrlTabTarget === "agents"
          ? e.key === "Control"
          : e.key === "Alt" || e.key === "Control"

      if (isRelevantKeyRelease) {
        conversationModifierKeysHeldRef.current = false

        // If timer is still running (quick press - dialog not shown yet)
        if (conversationHoldTimerRef.current) {
          clearTimeout(conversationHoldTimerRef.current)
          conversationHoldTimerRef.current = null

          // Do quick switch without showing dialog (only between open tabs)
          const store = useAgentConversationStore.getState()
          const currentOpenIds = store.openConversationIds
          const currentActiveId = store.activeConversationId

          if (currentOpenIds && currentOpenIds.length > 1) {
            if (!currentActiveId) {
              store.setActiveConversation(currentOpenIds[0])
              return
            }

            const currentIndex = currentOpenIds.indexOf(currentActiveId)
            if (currentIndex === -1) {
              store.setActiveConversation(currentOpenIds[0])
              return
            }

            let nextIndex: number
            if (conversationWasShiftPressedRef.current) {
              nextIndex = currentIndex - 1
              if (nextIndex < 0) nextIndex = currentOpenIds.length - 1
            } else {
              nextIndex = currentIndex + 1
              if (nextIndex >= currentOpenIds.length) nextIndex = 0
            }

            store.setActiveConversation(currentOpenIds[nextIndex])
          }
          return
        }

        // If dialog is open, navigate to selected conversation and close
        if (conversationQuickSwitchOpenRef.current) {
          const selectedConversation =
            frozenConversationsRef.current?.[
              conversationQuickSwitchSelectedIndexRef.current
            ]

          if (selectedConversation) {
            useAgentConversationStore.getState().setActiveConversation(selectedConversation.id)
          }

          setConversationQuickSwitchOpen(false)
          setConversationQuickSwitchSelectedIndex(0)
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    window.addEventListener("keyup", handleKeyUp)

    return () => {
      window.removeEventListener("keydown", handleKeyDown)
      window.removeEventListener("keyup", handleKeyUp)
      if (conversationHoldTimerRef.current) {
        clearTimeout(conversationHoldTimerRef.current)
      }
    }
  }, [setConversationQuickSwitchOpen, setConversationQuickSwitchSelectedIndex, ctrlTabTarget])

  // Note: Cmd+E archive hotkey is handled in AgentsSidebar to share undo stack

  const handleSignOut = async () => {
    setBillingMethod(null)
    setAnthropicOnboardingCompleted(false)
    setApiKeyOnboardingCompleted(false)
    await signOut()
  }

  // Check if conversations data is loaded (use separate selectors to avoid object creation)
  const conversationsStoreChatId = useAgentConversationStore((state) => state.chatId)
  const conversationsCount = useAgentConversationStore(
    (state) => state.allConversations.length,
  )

  // Check if conversations are still loading (store not yet initialized for this chat)
  const isLoadingConversations =
    selectedChatId !== null &&
    (conversationsStoreChatId !== selectedChatId || conversationsCount === 0)

  const handleSidebarChatSelect = useCallback((chatId: string) => {
    setSelectedChatId(chatId)
    setSelectedDraftId(null)
    setShowNewChatForm(false)
    setDesktopView(null)
    setMobileViewMode("chat")
  }, [
    setSelectedChatId,
    setSelectedDraftId,
    setShowNewChatForm,
    setDesktopView,
    setMobileViewMode,
  ])

  const handleWorkspaceCreated = useCallback(
    (workspaceId: string) => {
      setSelectedWorkspaceId(workspaceId)
      setConversationsSidebarMode("sidebar")
      setSelectedChatId(null)
      setSelectedDraftId(null)
      setShowNewChatForm(true)
      setDesktopView(null)
      setMobileViewMode("chat")
    },
    [
      setSelectedWorkspaceId,
      setConversationsSidebarMode,
      setSelectedChatId,
      setSelectedDraftId,
      setShowNewChatForm,
      setDesktopView,
      setMobileViewMode,
    ],
  )

  const handleNewChatClick = useCallback(() => {
    setSelectedChatId(null)
    setSelectedDraftId(null)
    setShowNewChatForm(true)
    setDesktopView(null)
  }, [
    setSelectedChatId,
    setSelectedDraftId,
    setShowNewChatForm,
    setDesktopView,
  ])

  // Track conversations sidebar open state for animation control
  // Now renders even while loading to show spinner (mobile always uses tabs)
  const isConversationsSidebarOpen =
    (selectedWorkspaceId || selectedChatId) &&
    conversationsSidebarMode === "sidebar" &&
    !isMobile &&
    !desktopView

  useEffect(() => {
    // When sidebar closes, reset for animation on next open
    if (!isConversationsSidebarOpen && wasConversationsSidebarOpen.current) {
      hasOpenedConversationsSidebar.current = false
      setShouldAnimateConversationsSidebar(true)
    }
    wasConversationsSidebarOpen.current = !!isConversationsSidebarOpen

    // Mark as opened after animation completes
    if (isConversationsSidebarOpen && !hasOpenedConversationsSidebar.current) {
      const timer = setTimeout(() => {
        hasOpenedConversationsSidebar.current = true
        setShouldAnimateConversationsSidebar(false)
      }, 150 + 50) // 150ms duration + 50ms buffer
      return () => clearTimeout(timer)
    } else if (isConversationsSidebarOpen && hasOpenedConversationsSidebar.current) {
      setShouldAnimateConversationsSidebar(false)
    }
  }, [isConversationsSidebarOpen])

  // Check if chat has sandbox with port for preview
  const chatMeta = chatData?.meta as
    | {
        sandboxConfig?: { port?: number }
        isQuickSetup?: boolean
        repository?: string
      }
    | undefined
  const isQuickSetup = chatMeta?.isQuickSetup === true
  const canShowPreview = !!(
    chatData?.sandbox_id &&
    !isQuickSetup &&
    chatMeta?.sandboxConfig?.port
  )
  // Check if diff can be shown (sandbox exists)
  const canShowDiff = !!chatData?.sandbox_id

  // Check if terminal can be shown (worktree exists - desktop only)
  // chatData type from getAgentChat query doesn't include worktreePath/branch fields
  // TODO: extend the API response type to include these fields
  const chatDataExtended = chatData as
    | (typeof chatData & { worktreePath?: string; branch?: string })
    | undefined
  const worktreePath = chatDataExtended?.worktreePath
  const canShowTerminal = !!worktreePath

  // Terminal scope key for shared terminals
  const terminalScopeKey = useMemo(() => {
    if (!selectedChatId || !worktreePath) return `ws:${selectedChatId || "none"}`
    return getTerminalScopeKey({
      branch: chatDataExtended?.branch ?? null,
      worktreePath: worktreePath,
      id: selectedChatId,
    })
  }, [chatDataExtended?.branch, worktreePath, selectedChatId])

  // Mobile layout - completely different structure
  if (isMobile) {
    return (
      <div
        className="flex h-full bg-background"
        data-agents-page
        data-mobile-view
      >
        {/* Mobile: Settings fullscreen view */}
        {desktopView === "settings" ? (
          <SettingsContent />
        ) : desktopView === "task-board" ? (
          <TaskBoardView />
        ) : desktopView === "add-agent" ? (
          <AddAgentViewPage />
        ) : mobileViewMode === "chats" ? (
          // Chats List Mode (default) - uses AgentsSidebar in fullscreen
          <AgentsSidebar
            userId={userId}
            clerkUser={user}
            onSignOut={handleSignOut}
            onToggleSidebar={() => {}}
            isMobileFullscreen={true}
            onChatSelect={() => setMobileViewMode("chat")}
          />
        ) : mobileViewMode === "preview" && selectedChatId && canShowPreview ? (
          // Preview Mode
          <AgentPreview
            chatId={selectedChatId}
            sandboxId={chatData!.sandbox_id!}
            port={chatMeta?.sandboxConfig?.port!}
            isMobile={true}
            onClose={() => setMobileViewMode("chat")}
          />
        ) : mobileViewMode === "diff" && selectedChatId && canShowDiff ? (
          // Diff Mode - fullscreen diff view
          <AgentDiffView
            chatId={selectedChatId}
            sandboxId={chatData!.sandbox_id!}
            worktreePath={worktreePath}
            repository={chatMeta?.repository}
            showFooter={true}
            isMobile={true}
            onClose={() => setMobileViewMode("chat")}
          />
        ) : mobileViewMode === "terminal" &&
          selectedChatId &&
          canShowTerminal ? (
          // Terminal Mode - fullscreen terminal
          <TerminalSidebar
            chatId={selectedChatId}
            scopeKey={terminalScopeKey}
            cwd={worktreePath!}
            workspaceId={selectedChatId}
            isMobileFullscreen={true}
            onClose={() => setMobileViewMode("chat")}
          />
        ) : (
          // Chat Mode - shows either ChatView or NewChatForm
          <div
            className="h-full w-full flex flex-col overflow-hidden select-text"
            data-mobile-chat-mode
          >
            {selectedChatId ? (
              <ChatView
                key={selectedChatId}
                chatId={selectedChatId}
                isSidebarOpen={false}
                onToggleSidebar={() => {}}
                selectedTeamName={undefined}
                selectedTeamImageUrl={undefined}
                isMobileFullscreen={true}
                onBackToChats={() => {
                  setMobileViewMode("chats")
                  setSelectedChatId(null)
                }}
                onOpenPreview={
                  canShowPreview
                    ? () => setMobileViewMode("preview")
                    : undefined
                }
                onOpenDiff={
                  canShowDiff ? () => setMobileViewMode("diff") : undefined
                }
                onOpenTerminal={
                  canShowTerminal
                    ? () => {
                        setTerminalSidebarOpen(true)
                        setMobileViewMode("terminal")
                      }
                    : undefined
                }
              />
            ) : selectedDraftId || showNewChatForm ? (
                <div className="h-full flex flex-col relative overflow-hidden">
                  <NewChatForm
                    isMobileFullscreen={true}
                    selectedWorkspaceId={selectedWorkspaceId}
                    onBackToChats={() => setMobileViewMode("chats")}
                  />
                </div>
              ) : (
                <AgentsDefaultView
                  onWorkspaceCreated={handleWorkspaceCreated}
                />
              )}
            </div>
          )}
        </div>
      )
    }

  // Desktop layout
  return (
    <>
      <div className="flex h-full">
        {/* Session sidebar - only show in sidebar mode when a workspace is active */}
          <ResizableSidebar
          isOpen={!!isConversationsSidebarOpen}
          onClose={() => {
            setShouldAnimateConversationsSidebar(true)
            setConversationsSidebarMode("tabs")
          }}
          widthAtom={agentsConversationsSidebarWidthAtom}
          minWidth={160}
          maxWidth={300}
          side="left"
          animationDuration={0.24}
          initialWidth={0}
          exitWidth={0}
          disableClickToClose={true}
          persistContent={true}
        >
          <AgentsConversationsSidebar
            onClose={() => {
              setShouldAnimateConversationsSidebar(true)
              setConversationsSidebarMode("tabs")
            }}
            isMobile={isMobile}
            isSidebarOpen={sidebarOpen}
            onBackToChats={() => setSidebarOpen((prev) => !prev)}
            isLoading={isLoadingConversations}
            workspaceId={selectedWorkspaceId}
            workspaceName={selectedWorkspace?.name ?? null}
            agentName={chatData?.name ?? undefined}
            onChatSelect={handleSidebarChatSelect}
            onNewChatClick={handleNewChatClick}
          />
        </ResizableSidebar>

        {/* Main content */}
        <div
          className="relative flex-1 min-w-[350px] overflow-hidden"
        >
          <AnimatePresence initial={false}>
            <motion.div
              key={collaborationMode}
              className="absolute inset-0"
              initial={{ x: collaborationMode === "group" ? "100%" : "-100%" }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ x: collaborationMode === "group" ? "100%" : "-100%" }}
              transition={{ duration: 0.28, ease: "easeOut" }}
            >
              {desktopView === "settings" ? (
                <SettingsContent />
              ) : desktopView === "task-board" ? (
                <TaskBoardView />
              ) : desktopView === "add-agent" ? (
                <AddAgentViewPage />
              ) : selectedChatId ? (
                <div className="h-full flex flex-col relative overflow-hidden">
                  <ChatView
                    key={selectedChatId}
                    chatId={selectedChatId}
                    isSidebarOpen={sidebarOpen}
                    onToggleSidebar={() => setSidebarOpen((prev) => !prev)}
                    selectedTeamName={undefined}
                    selectedTeamImageUrl={undefined}
                  />
                </div>
              ) : selectedDraftId || showNewChatForm ? (
                <div className="h-full flex flex-col relative overflow-hidden">
                  <NewChatForm
                    key={`new-chat-${newChatFormKeyRef.current}`}
                    selectedWorkspaceId={selectedWorkspaceId}
                  />
                </div>
              ) : (
                <div className="h-full flex relative overflow-hidden">
                  <AgentsDefaultView
                    onWorkspaceCreated={handleWorkspaceCreated}
                  />
                </div>
              )}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>

      {/* Quick-switch dialog - Agents (Opt+Ctrl+Tab) */}
      <AgentsQuickSwitchDialog
        isOpen={quickSwitchOpen}
        chats={
          quickSwitchOpen ? (frozenRecentChatsRef.current ?? []) : recentChats
        }
        selectedIndex={quickSwitchSelectedIndex}
        projectsMap={projectsMap}
        onHover={setQuickSwitchSelectedIndex}
      />

      {/* Quick-switch dialog - Conversations (Ctrl+Tab) */}
      <ConversationsQuickSwitchDialog
        isOpen={conversationQuickSwitchOpen}
        conversations={
          conversationQuickSwitchOpen
            ? (frozenConversationsRef.current ?? [])
            : recentConversations
        }
        selectedIndex={conversationQuickSwitchSelectedIndex}
        onHover={setConversationQuickSwitchSelectedIndex}
      />

      {/* Dev mode / Admin sandbox debugger */}
      {(import.meta.env.DEV || isAdmin) &&
        chatData?.sandbox_id && (
          <a
            href={`https://codesandbox.io/p/devbox/${chatData.sandbox_id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="fixed bottom-4 right-4 z-50 bg-zinc-900 text-zinc-300 px-3 py-1.5 rounded-md text-xs font-mono opacity-70 hover:opacity-100 hover:bg-zinc-800 transition-all cursor-pointer"
          >
            sandbox: {chatData.sandbox_id}
          </a>
        )}
    </>
  )
}
