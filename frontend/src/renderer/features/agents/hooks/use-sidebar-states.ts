import { useCallback, useEffect, useMemo, useRef } from "react"
import { useAtom, useAtomValue, useSetAtom } from "jotai"
import {
  agentsPreviewSidebarOpenAtom,
  diffSidebarOpenAtomFamily,
  planSidebarOpenAtomFamily,
  currentPlanPathAtomFamily,
  fileViewerOpenAtomFamily,
  fileViewerDisplayModeAtom,
  fileSearchDialogOpenAtom,
  selectedDiffFilePathAtom,
} from "../atoms"
import {
  terminalSidebarOpenAtomFamily,
  terminalDisplayModeAtom,
} from "../../terminal/atoms"
import {
  detailsSidebarOpenAtom,
  detailsSidebarTabAtom,
  sideChatSidebarOpenAtom,
  unifiedSidebarEnabledAtom,
} from "../../details-sidebar/atoms"
import { useAgentConversationStore } from "../stores/conversation-store"
import { pendingBuildPlanConversationIdAtom } from "../atoms"
import { useResolvedHotkeyDisplay } from "../../../lib/hotkeys"

export function useSidebarStates(chatId: string) {
  // Preview sidebar
  const [isPreviewSidebarOpen, setIsPreviewSidebarOpen] = useAtom(
    agentsPreviewSidebarOpenAtom,
  )

  // Diff sidebar - per-chat state
  const diffSidebarAtom = useMemo(
    () => diffSidebarOpenAtomFamily(chatId),
    [chatId],
  )
  const [isDiffSidebarOpen, setIsDiffSidebarOpen] = useAtom(diffSidebarAtom)

  // Plan sidebar - per-conversation state
  const activeConversationIdForPlan = useAgentConversationStore(
    (state) => state.activeConversationId,
  )
  const planSidebarAtom = useMemo(
    () => planSidebarOpenAtomFamily(activeConversationIdForPlan || ""),
    [activeConversationIdForPlan],
  )
  const [isPlanSidebarOpen, setIsPlanSidebarOpen] = useAtom(planSidebarAtom)
  const currentPlanPathAtom = useMemo(
    () => currentPlanPathAtomFamily(activeConversationIdForPlan || ""),
    [activeConversationIdForPlan],
  )
  const [currentPlanPath, setCurrentPlanPath] = useAtom(currentPlanPathAtom)

  // File viewer sidebar - per-chat state
  const fileViewerAtom = useMemo(
    () => fileViewerOpenAtomFamily(chatId),
    [chatId],
  )
  const [fileViewerPath, setFileViewerPath] = useAtom(fileViewerAtom)
  const [fileViewerDisplayMode] = useAtom(fileViewerDisplayModeAtom)
  const selectedFilePath = useAtomValue(selectedDiffFilePathAtom)

  // File search dialog
  const [fileSearchOpen, setFileSearchOpen] = useAtom(fileSearchDialogOpenAtom)

  // Details sidebar (unified sidebar)
  const isUnifiedSidebarEnabled = useAtomValue(unifiedSidebarEnabledAtom)
  const [isDetailsSidebarOpen, setIsDetailsSidebarOpen] = useAtom(detailsSidebarOpenAtom)
  const [detailsSidebarTab, setDetailsSidebarTab] = useAtom(detailsSidebarTabAtom)
  const [isSideChatSidebarOpen, setIsSideChatSidebarOpen] = useAtom(sideChatSidebarOpenAtom)

  // Terminal sidebar - per-chat state
  const terminalSidebarAtom = useMemo(
    () => terminalSidebarOpenAtomFamily(chatId),
    [chatId],
  )
  const [isTerminalSidebarOpen, setIsTerminalSidebarOpen] = useAtom(terminalSidebarAtom)
  const terminalDisplayMode = useAtomValue(terminalDisplayModeAtom)

  // Toggle details sidebar tab
  const handleToggleDetailsSidebarTab = useCallback(
    (tab: typeof detailsSidebarTab) => {
      if (isDetailsSidebarOpen && detailsSidebarTab === tab) {
        setIsDetailsSidebarOpen(false)
      } else {
        setDetailsSidebarTab(tab)
        setIsDetailsSidebarOpen(true)
      }
    },
    [isDetailsSidebarOpen, detailsSidebarTab, setDetailsSidebarTab, setIsDetailsSidebarOpen],
  )

  // Resolved hotkeys for tooltips
  const toggleDetailsHotkey = useResolvedHotkeyDisplay("toggle-details")
  const toggleTerminalHotkey = useResolvedHotkeyDisplay("toggle-terminal")

  // Close plan sidebar when switching conversations
  const prevConversationIdRef = useRef(activeConversationIdForPlan)
  useEffect(() => {
    if (prevConversationIdRef.current !== activeConversationIdForPlan) {
      if (!currentPlanPath) {
        setIsPlanSidebarOpen(false)
      }
      prevConversationIdRef.current = activeConversationIdForPlan
    }
  }, [activeConversationIdForPlan, currentPlanPath, setIsPlanSidebarOpen])

  // Plan approval handler
  const setPendingBuildPlanConversationId = useSetAtom(pendingBuildPlanConversationIdAtom)
  const handleApprovePlanFromSidebar = useCallback(() => {
    const activeConversationId = useAgentConversationStore.getState().activeConversationId
    if (activeConversationId) {
      setPendingBuildPlanConversationId(activeConversationId)
    }
  }, [setPendingBuildPlanConversationId])

  // Terminal keyboard shortcut (Cmd+J)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.metaKey &&
        !e.altKey &&
        !e.shiftKey &&
        !e.ctrlKey &&
        e.code === "KeyJ"
      ) {
        e.preventDefault()
        e.stopPropagation()
        setIsTerminalSidebarOpen(!isTerminalSidebarOpen)
      }
    }

    window.addEventListener("keydown", handleKeyDown, true)
    return () => window.removeEventListener("keydown", handleKeyDown, true)
  }, [isTerminalSidebarOpen, setIsTerminalSidebarOpen])

  return {
    // Preview
    isPreviewSidebarOpen,
    setIsPreviewSidebarOpen,

    // Diff
    isDiffSidebarOpen,
    setIsDiffSidebarOpen,
    selectedFilePath,

    // Plan
    isPlanSidebarOpen,
    setIsPlanSidebarOpen,
    currentPlanPath,
    setCurrentPlanPath,
    handleApprovePlanFromSidebar,

    // File viewer
    fileViewerPath,
    setFileViewerPath,
    fileViewerDisplayMode,
    fileSearchOpen,
    setFileSearchOpen,

    // Details sidebar
    isUnifiedSidebarEnabled,
    isDetailsSidebarOpen,
    setIsDetailsSidebarOpen,
    detailsSidebarTab,
    setDetailsSidebarTab,
    handleToggleDetailsSidebarTab,
    toggleDetailsHotkey,

    // Side chat
    isSideChatSidebarOpen,
    setIsSideChatSidebarOpen,

    // Terminal
    isTerminalSidebarOpen,
    setIsTerminalSidebarOpen,
    terminalDisplayMode,
    toggleTerminalHotkey,
  }
}
