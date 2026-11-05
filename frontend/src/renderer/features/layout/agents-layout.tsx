import { useCallback, useEffect, useState, useMemo, useRef } from "react"
import { useAtom, useAtomValue, useSetAtom } from "jotai"
import { toast } from "sonner"
import { isDesktopApp } from "../../lib/utils/platform"
import { useIsMobile } from "../../lib/hooks/use-mobile"

import {
  agentsSidebarOpenAtom,
  agentsSidebarWidthAtom,
  agentsSettingsDialogActiveTabAtom,
  agentsSettingsDialogOpenAtom,
  apiKeyOnboardingCompletedAtom,
  billingMethodAtom,
  claudeLoginModalConfigAtom,
  isDesktopAtom,
  isFullscreenAtom,
  customHotkeysAtom,
  betaKanbanEnabledAtom,
} from "../../lib/atoms"
import { selectedAgentChatIdAtom, selectedWorkspaceAtom, selectedDraftIdAtom, showNewChatFormAtom, desktopViewAtom, fileSearchDialogOpenAtom } from "../agents"
import { detailsSidebarOpenAtom, detailsSidebarTabAtom, sideChatSidebarOpenAtom } from "../details-sidebar/atoms"
import { terminalSidebarOpenAtomFamily } from "../terminal/atoms"
import { diffSidebarOpenAtomFamily } from "../agents/atoms"
import { trpc } from "../../lib/trpc"
import { useAgentsHotkeys } from "../agents"
import { toggleSearchAtom } from "../agents"
import { ClaudeLoginModal } from "../../components/dialogs/claude-login-modal"
import { TooltipProvider } from "../../components/ui/tooltip"
import { ResizableSidebar } from "../../components/ui/resizable-sidebar"
import { AgentsSidebar } from "../sidebar"
import { AgentsContent } from "../agents"
import { UpdateBanner } from "../../components/update-banner"
import { WindowsTitleBar } from "../../components/windows-title-bar"
import { useUpdateChecker } from "../../lib/hooks/use-update-checker"
import { useAgentConversationStore } from "../agents"
import { QueueProcessor } from "../agents"
import { SettingsSidebar } from "../settings"

// ============================================================================
// Constants
// ============================================================================

const SIDEBAR_MIN_WIDTH = 160
const SIDEBAR_MAX_WIDTH = 300
const SIDEBAR_ANIMATION_DURATION = 0.24
const SIDEBAR_CLOSE_HOTKEY = "⌘\\"

// ============================================================================
// Component
// ============================================================================

export function AgentsLayout() {
  // No useHydrateAtoms - desktop doesn't need SSR, atomWithStorage handles persistence
  const isMobile = useIsMobile()

  // Global desktop/fullscreen state - initialized here at root level
  const [isDesktop, setIsDesktop] = useAtom(isDesktopAtom)
  const [isFullscreen, setIsFullscreen] = useAtom(isFullscreenAtom)

  // Initialize isDesktop on mount
  useEffect(() => {
    setIsDesktop(isDesktopApp())
  }, [setIsDesktop])

  // Subscribe to fullscreen changes from Electron
  useEffect(() => {
    if (
      !isDesktop ||
      typeof window === "undefined" ||
      !window.desktopApi?.windowIsFullscreen
    )
      return

    // Get initial fullscreen state
    window.desktopApi.windowIsFullscreen().then(setIsFullscreen)

    // In dev mode, HMR breaks IPC event subscriptions, so we poll instead
    const isDev = import.meta.env.DEV
    if (isDev) {
      const interval = setInterval(() => {
        window.desktopApi?.windowIsFullscreen?.().then(setIsFullscreen)
      }, 300)
      return () => clearInterval(interval)
    }

    // In production, use events (more efficient)
    const unsubscribe = window.desktopApi.onFullscreenChange?.(setIsFullscreen)
    return unsubscribe
  }, [isDesktop, setIsFullscreen])

  // Check for updates on mount and periodically
  useUpdateChecker()

  const [sidebarOpen, setSidebarOpen] = useAtom(agentsSidebarOpenAtom)
  const isLinuxTitleBar =
    typeof window !== "undefined" && window.desktopApi?.platform === "linux"
  const [_sidebarWidth, _setSidebarWidth] = useAtom(agentsSidebarWidthAtom)
  const setSettingsActiveTab = useSetAtom(agentsSettingsDialogActiveTabAtom)
  const setSettingsDialogOpen = useSetAtom(agentsSettingsDialogOpenAtom)
  const desktopView = useAtomValue(desktopViewAtom)
  const setFileSearchDialogOpen = useSetAtom(fileSearchDialogOpenAtom)
  const [selectedChatId, setSelectedChatId] = useAtom(selectedAgentChatIdAtom)

  // Right panel state (for history navigation)
  const [isDetailsSidebarOpen, setIsDetailsSidebarOpen] = useAtom(detailsSidebarOpenAtom)
  const [detailsSidebarTab, setDetailsSidebarTab] = useAtom(detailsSidebarTabAtom)
  const [isSideChatSidebarOpen, setIsSideChatSidebarOpen] = useAtom(sideChatSidebarOpenAtom)
  const terminalSidebarAtom = useMemo(
    () => terminalSidebarOpenAtomFamily(selectedChatId || ""),
    [selectedChatId],
  )
  const [isTerminalSidebarOpen, setIsTerminalSidebarOpen] = useAtom(terminalSidebarAtom)
  const diffSidebarAtom = useMemo(
    () => diffSidebarOpenAtomFamily(selectedChatId || ""),
    [selectedChatId],
  )
  const [isDiffSidebarOpen, setIsDiffSidebarOpen] = useAtom(diffSidebarAtom)
  const [selectedWorkspace, setSelectedWorkspace] = useAtom(selectedWorkspaceAtom)
  const setSelectedDraftId = useSetAtom(selectedDraftIdAtom)
  const setShowNewChatForm = useSetAtom(showNewChatFormAtom)
  const betaKanbanEnabled = useAtomValue(betaKanbanEnabledAtom)
  const setDesktopView = useSetAtom(desktopViewAtom)

  // Top-level page history for Back/Forward navigation
  const [pageHistory, setPageHistory] = useState<Array<{
    desktopView: string | null
    selectedChatId: string | null
    sidebarOpen: boolean
    detailsOpen: boolean
    detailsTab: string
    sideChatOpen: boolean
    terminalOpen: boolean
    diffOpen: boolean
  }>>([{
    desktopView,
    selectedChatId,
    sidebarOpen,
    detailsOpen: isDetailsSidebarOpen,
    detailsTab: detailsSidebarTab,
    sideChatOpen: isSideChatSidebarOpen,
    terminalOpen: isTerminalSidebarOpen,
    diffOpen: isDiffSidebarOpen,
  }])
  const [pageHistoryIndex, setPageHistoryIndex] = useState(0)

  useEffect(() => {
    const current = pageHistory[pageHistoryIndex]
    if (
      desktopView === current?.desktopView &&
      selectedChatId === current?.selectedChatId &&
      sidebarOpen === current?.sidebarOpen &&
      isDetailsSidebarOpen === current?.detailsOpen &&
      detailsSidebarTab === current?.detailsTab &&
      isSideChatSidebarOpen === current?.sideChatOpen &&
      isTerminalSidebarOpen === current?.terminalOpen &&
      isDiffSidebarOpen === current?.diffOpen
    )
      return
    const trimmed = pageHistory.slice(0, pageHistoryIndex + 1)
    trimmed.push({
      desktopView,
      selectedChatId,
      sidebarOpen,
      detailsOpen: isDetailsSidebarOpen,
      detailsTab: detailsSidebarTab,
      sideChatOpen: isSideChatSidebarOpen,
      terminalOpen: isTerminalSidebarOpen,
      diffOpen: isDiffSidebarOpen,
    })
    setPageHistory(trimmed)
    setPageHistoryIndex(trimmed.length - 1)
  }, [desktopView, selectedChatId, sidebarOpen, isDetailsSidebarOpen, detailsSidebarTab, isSideChatSidebarOpen, isTerminalSidebarOpen, isDiffSidebarOpen]) // eslint-disable-line react-hooks/exhaustive-deps

  const handlePageBack = useCallback(() => {
    if (pageHistoryIndex <= 0) return
    const nextIndex = pageHistoryIndex - 1
    const target = pageHistory[nextIndex]
    setPageHistoryIndex(nextIndex)
    setDesktopView(target.desktopView as any)
    setSelectedChatId(target.selectedChatId as any)
    setSidebarOpen(target.sidebarOpen)
    setIsDetailsSidebarOpen(target.detailsOpen)
    setDetailsSidebarTab(target.detailsTab as any)
    setIsSideChatSidebarOpen(target.sideChatOpen)
    setIsTerminalSidebarOpen(target.terminalOpen)
    setIsDiffSidebarOpen(target.diffOpen)
  }, [pageHistory, pageHistoryIndex, setDesktopView, setSelectedChatId, setSidebarOpen, setIsDetailsSidebarOpen, setDetailsSidebarTab, setIsSideChatSidebarOpen, setIsTerminalSidebarOpen, setIsDiffSidebarOpen])

  const handlePageForward = useCallback(() => {
    if (pageHistoryIndex >= pageHistory.length - 1) return
    const nextIndex = pageHistoryIndex + 1
    const target = pageHistory[nextIndex]
    setPageHistoryIndex(nextIndex)
    setDesktopView(target.desktopView as any)
    setSelectedChatId(target.selectedChatId as any)
    setSidebarOpen(target.sidebarOpen)
    setIsDetailsSidebarOpen(target.detailsOpen)
    setDetailsSidebarTab(target.detailsTab as any)
    setIsSideChatSidebarOpen(target.sideChatOpen)
    setIsTerminalSidebarOpen(target.terminalOpen)
    setIsDiffSidebarOpen(target.diffOpen)
  }, [pageHistory, pageHistoryIndex, setDesktopView, setSelectedChatId, setSidebarOpen, setIsDetailsSidebarOpen, setDetailsSidebarTab, setIsSideChatSidebarOpen, setIsTerminalSidebarOpen, setIsDiffSidebarOpen])
  const setApiKeyOnboardingCompleted = useSetAtom(apiKeyOnboardingCompletedAtom)
  const setBillingMethod = useSetAtom(billingMethodAtom)
  const claudeLoginModalConfig = useAtomValue(claudeLoginModalConfigAtom)

  // Fetch projects to validate selectedWorkspace exists
  const { data: projects, isLoading: isLoadingProjects } =
    trpc.projects.list.useQuery(undefined, { staleTime: Infinity })

  // Validated project - only valid if exists in DB
  // While loading, trust localStorage value to prevent clearing on app restart
  const validatedProject = useMemo(() => {
    if (!selectedWorkspace) return null
    // While loading, trust localStorage value to prevent flicker and clearing
    if (isLoadingProjects) return selectedWorkspace
    // After loading, validate against DB
    if (!projects) return null
    const exists = projects.some((p) => p.id === selectedWorkspace.id)
    return exists ? selectedWorkspace : null
  }, [selectedWorkspace, projects, isLoadingProjects])

  // Clear invalid project from storage (only after loading completes)
  useEffect(() => {
    if (
      selectedWorkspace &&
      projects &&
      !isLoadingProjects &&
      !validatedProject
    ) {
      setSelectedWorkspace(null)
    }
  }, [
    selectedWorkspace,
    projects,
    isLoadingProjects,
    validatedProject,
    setSelectedWorkspace,
  ])

  // Show/hide native traffic lights based on sidebar and fullscreen state
  // This also re-syncs visibility when leaving fullscreen.
  // When settings view is active, don't control traffic lights here —
  // SettingsSidebar manages its own visibility (always hidden).
  const isSettingsView = desktopView === "settings"
  useEffect(() => {
    if (!isDesktop) return
    if (isSettingsView) return // SettingsSidebar handles its own traffic light state
    if (
      typeof window === "undefined" ||
      !window.desktopApi?.setTrafficLightVisibility
    )
      return

    window.desktopApi.setTrafficLightVisibility(sidebarOpen)
  }, [sidebarOpen, isDesktop, isFullscreen, isSettingsView])

  const setChatId = useAgentConversationStore((state) => state.setChatId)

  // Desktop user state
  const [desktopUser, setDesktopUser] = useState<{
    id: string
    email: string
    name: string | null
    imageUrl: string | null
    username: string | null
  } | null>(null)

  // Fetch desktop user on mount
  useEffect(() => {
    async function fetchUser() {
      if (window.desktopApi?.getUser) {
        const user = await window.desktopApi.getUser()
        setDesktopUser(user)
      }
    }
    fetchUser()
  }, [])

  // Track if this is the initial load - skip auto-open on first load to respect saved state
  const isInitialLoadRef = useRef(true)

  // Auto-open sidebar when project is selected, close when no project
  // Skip on initial load to preserve user's saved sidebar preference
  useEffect(() => {
    if (!projects) return // Don't change sidebar state while loading

    // On initial load, just mark as loaded and don't change sidebar state
    if (isInitialLoadRef.current) {
      isInitialLoadRef.current = false
      return
    }

    // After initial load, react to project changes
    if (validatedProject) {
      setSidebarOpen(true)
    } else {
      setSidebarOpen(false)
    }
  }, [validatedProject, projects, setSidebarOpen])

  // Worktree setup failures from main process
  useEffect(() => {
    if (typeof window === "undefined") return
    const desktopApi = window.desktopApi
    // Type guard: onWorktreeSetupFailed may not be in all DesktopApi type definitions
    if (!desktopApi || !("onWorktreeSetupFailed" in desktopApi)) return

    const unsubscribe =
      (desktopApi as { onWorktreeSetupFailed: (cb: (payload: { kind: "create-failed" | "setup-failed"; message: string; projectId: string }) => void) => () => void }).onWorktreeSetupFailed((payload: { kind: "create-failed" | "setup-failed"; message: string; projectId: string }) => {
      const errorMessage = payload.message.replace(/\s+/g, " ").trim()
      const title =
        payload.kind === "create-failed"
          ? "Worktree creation failed"
          : "Worktree setup failed"

      toast.error(title, {
        description: errorMessage || undefined,
        duration: 10000,
        action: {
          label: "Open settings",
          onClick: () => {
            const projectMatch = projects?.find((project) => project.id === payload.projectId)
            if (projectMatch) {
              setSelectedWorkspace({
                id: projectMatch.id,
                name: projectMatch.name,
                path: projectMatch.path,
                gitRemoteUrl: projectMatch.gitRemoteUrl ?? null,
                gitProvider: (projectMatch.gitProvider as "github" | "gitlab" | "bitbucket" | null) ?? null,
                gitOwner: projectMatch.gitOwner ?? null,
                gitRepo: projectMatch.gitRepo ?? null,
              })
            }
            setSettingsActiveTab("projects")
            setSettingsDialogOpen(true)
          },
        },
      })
    })

    return unsubscribe
  }, [projects, setSelectedWorkspace, setSettingsActiveTab, setSettingsDialogOpen])

  // Handle sign out
  const handleSignOut = useCallback(async () => {
    // Reset onboarding/provider selection state on logout.
    setSelectedWorkspace(null)
    setSelectedChatId(null)
    setBillingMethod(null)
    setApiKeyOnboardingCompleted(false)
    if (window.desktopApi?.logout) {
      await window.desktopApi.logout()
    }
  }, [
    setSelectedWorkspace,
    setSelectedChatId,
    setBillingMethod,
    setApiKeyOnboardingCompleted,
  ])

  // Clear conversation store when no chat is selected
  useEffect(() => {
    if (!selectedChatId) {
      setChatId(null)
    }
  }, [selectedChatId, setChatId])

  // Chat search toggle
  const toggleChatSearch = useSetAtom(toggleSearchAtom)

  // Custom hotkeys config
  const customHotkeysConfig = useAtomValue(customHotkeysAtom)

  // Initialize hotkeys manager
  useAgentsHotkeys({
    setSelectedChatId,
    setSelectedDraftId,
    setShowNewChatForm,
    setDesktopView,
    setSidebarOpen,
    setSettingsActiveTab,
    setFileSearchDialogOpen,
    toggleChatSearch,
    selectedChatId,
    customHotkeysConfig,
    betaKanbanEnabled,
  })

  const handleCloseSidebar = useCallback(() => {
    setSidebarOpen(false)
  }, [setSidebarOpen])

  return (
    <TooltipProvider delayDuration={300}>
      {/* Global queue processor - handles message queues for all conversations */}
      <QueueProcessor />
      <ClaudeLoginModal
        hideCustomModelSettingsLink={
          claudeLoginModalConfig.hideCustomModelSettingsLink
        }
        autoStartAuth={claudeLoginModalConfig.autoStartAuth}
      />
      <div className="flex flex-col w-full h-full relative overflow-hidden bg-background select-none">
        {/* Windows Title Bar (only shown on Windows with frameless window) */}
        <WindowsTitleBar
          onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
          sidebarOpen={sidebarOpen}
          onBack={handlePageBack}
          onForward={handlePageForward}
          canBack={pageHistoryIndex > 0}
          canForward={pageHistoryIndex < pageHistory.length - 1}
          pageTitle={desktopView === "settings" ? "Settings" : ""}
        />
        <div className="flex flex-1 overflow-hidden bg-tl-background">
          {/* Left Sidebar - switches between chat list and settings nav */}
          <ResizableSidebar
          isOpen={!isMobile && sidebarOpen}
          onClose={handleCloseSidebar}
          widthAtom={agentsSidebarWidthAtom}
          minWidth={SIDEBAR_MIN_WIDTH}
          maxWidth={SIDEBAR_MAX_WIDTH}
          side="left"
          closeHotkey={SIDEBAR_CLOSE_HOTKEY}
          animationDuration={SIDEBAR_ANIMATION_DURATION}
          initialWidth={0}
          exitWidth={0}
          persistContent={true}
          showResizeTooltip={!isSettingsView}
          className="overflow-hidden bg-background"
        >
          {isSettingsView ? (
            <SettingsSidebar />
          ) : (
            <AgentsSidebar
              desktopUser={desktopUser ? { id: desktopUser.id, email: desktopUser.email, name: desktopUser.name ?? undefined } : null}
              onSignOut={handleSignOut}
              onToggleSidebar={isLinuxTitleBar ? undefined : handleCloseSidebar}
            />
          )}
        </ResizableSidebar>

          {/* Main Content */}
          <div className="flex-1 overflow-hidden flex flex-col min-w-0 rounded-tl-2xl bg-background">
            <AgentsContent />
          </div>
        </div>

        {/* Update Banner */}
        <UpdateBanner />
      </div>
    </TooltipProvider>
  )
}
