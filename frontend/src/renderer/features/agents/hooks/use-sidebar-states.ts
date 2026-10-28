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
import { customHotkeysAtom } from "../../../lib/atoms"
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
import { useResolvedHotkeyDisplay, getResolvedKeys } from "../../../lib/hotkeys"

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
  // Use a unique sentinel key per hook instance to avoid state leakage across null-conversation contexts
  const nullConversationSentinelRef = useRef(`__null_conv_${Math.random().toString(36).slice(2)}`)
  const planSidebarKey = activeConversationIdForPlan || nullConversationSentinelRef.current
  const planSidebarAtom = useMemo(
    () => planSidebarOpenAtomFamily(planSidebarKey),
    [planSidebarKey],
  )
  const [isPlanSidebarOpen, setIsPlanSidebarOpen] = useAtom(planSidebarAtom)
  const currentPlanPathAtom = useMemo(
    () => currentPlanPathAtomFamily(planSidebarKey),
    [planSidebarKey],
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

  // Get the actual resolved keys for the toggle-terminal action
  const customHotkeysConfig = useAtomValue(customHotkeysAtom)
  const toggleTerminalKeys = useMemo(
    () => getResolvedKeys("toggle-terminal", customHotkeysConfig),
    [customHotkeysConfig],
  )

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

  // Terminal keyboard shortcut (respects custom hotkey bindings)
  useEffect(() => {
    if (!toggleTerminalKeys) return

    const handleKeyDown = (e: KeyboardEvent) => {
      // Check if the pressed keys match the configured toggle-terminal hotkey
      const hasMeta = e.metaKey
      const hasCtrl = e.ctrlKey
      const hasAlt = e.altKey
      const hasShift = e.shiftKey

      // Build the pressed key combination
      const pressedKeys: string[] = []
      if (hasMeta) pressedKeys.push("cmd")
      if (hasCtrl) pressedKeys.push("ctrl")
      if (hasAlt) pressedKeys.push("alt")
      if (hasShift) pressedKeys.push("shift")

      // Add the main key (convert e.code to lowercase key name)
      const mainKey = e.code.replace("Key", "").toLowerCase()
      if (mainKey !== e.code.toLowerCase()) {
        pressedKeys.push(mainKey)
      } else {
        // For special keys, use the code as-is
        pressedKeys.push(e.code.toLowerCase())
      }

      // Check if pressed keys match the configured hotkey
      const matches = toggleTerminalKeys.every((key) => {
        if (key === "cmd") return hasMeta
        if (key === "ctrl") return hasCtrl
        if (key === "alt") return hasAlt
        if (key === "shift") return hasShift
        // Check if the main key matches
        return pressedKeys.includes(key.toLowerCase())
      }) && pressedKeys.length === toggleTerminalKeys.length

      if (matches) {
        e.preventDefault()
        e.stopPropagation()
        setIsTerminalSidebarOpen((prev) => !prev)
      }
    }

    window.addEventListener("keydown", handleKeyDown, true)
    return () => window.removeEventListener("keydown", handleKeyDown, true)
  }, [toggleTerminalKeys, setIsTerminalSidebarOpen])

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
