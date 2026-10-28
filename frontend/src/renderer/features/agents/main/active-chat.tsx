"use client"

import {
  stripEmojis
} from "../../../components/chat-markdown-renderer"
import { Button } from "../../../components/ui/button"
import {
  AgentIcon,
  AttachIcon,
  CheckIcon,
  ClaudeCodeIcon,
  CollapseIcon,
  CopyIcon,
  CursorIcon,
  ExpandIcon,
  IconCloseSidebarRight,
  IconOpenSidebarRight,
  IconSpinner,
  PauseIcon,
  UnarchiveIcon,
  VolumeIcon
} from "../../../components/ui/icons"
import { Kbd } from "../../../components/ui/kbd"
import {
  PromptInput,
  PromptInputActions
} from "../../../components/ui/prompt-input"
import { ResizableSidebar } from "../../../components/ui/resizable-sidebar"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../../../components/ui/tooltip"
// e2b API routes are used instead of useSandboxManager for agents
// import { clearConversationSelectionAtom, isConversationMultiSelectModeAtom, selectedConversationIdsAtom } from "@/lib/atoms/agent-subchat-selection"
import { ResizableBottomPanel } from "@/components/ui/resizable-bottom-panel"
import { Chat, useChat, type UIMessage } from "@ai-sdk/react"
import { atom, useAtom, useAtomValue, useSetAtom } from "jotai"
import {
  ArrowDown,
  ChevronDown,
  Folder,
  GitFork,
  ListTree,
  TerminalSquare
} from "lucide-react"
import { AnimatePresence, motion } from "motion/react"
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react"
import { flushSync } from "react-dom"
import { toast } from "sonner"
import { useShallow } from "zustand/react/shallow"
import type { FileStatus } from "../../../../shared/changes-types"
import { getQueryClient } from "../../../contexts/TRPCProvider"
import { trackMessageSent } from "../../../lib/analytics"
import {
  customClaudeConfigAtom,
  defaultAgentModeAtom,
  isDesktopAtom, isFullscreenAtom,
  normalizeCustomClaudeConfig,
  sessionInfoAtom,
  selectedOllamaModelAtom,
  soundNotificationsEnabledAtom
} from "../../../lib/atoms"
import { useChatAutoScroll } from "../hooks/use-chat-auto-scroll"
import { useSidebarStates } from "../hooks/use-sidebar-states"
import { usePendingActions } from "../hooks/use-pending-actions"
import { useQuestionHandling } from "../hooks/use-question-handling"
import { useQuestionAnswers } from "../hooks/use-question-answers"
import { useMessageSending } from "../hooks/use-message-sending"
import { useConversationActions } from "../hooks/use-conversation-actions"
import { usePlanApproval } from "../hooks/use-plan-approval"
import { useQuickComment } from "../hooks/use-quick-comment"
import { usePrDetection } from "../hooks/use-pr-detection"
import { useScrollManagement, getSavedScrollPosition } from "../hooks/use-scroll-management"
import { useProviderSelection } from "../hooks/use-provider-selection"
import { useCollaborationParticipants } from "../hooks/use-collaboration-participants"
import { useUnapprovedPlanDetection } from "../hooks/use-unapproved-plan-detection"
import { useGitOperations } from "../hooks/use-git-operations"
import { useCreateNewConversation } from "../hooks/use-create-new-conversation"
import { useDiffStatsManagement } from "../hooks/use-diff-stats-management"
import { useForkConversation } from "../hooks/use-fork-conversation"
import { useTabsToRender } from "../hooks/use-tabs-to-render"
import { useRollback } from "../hooks/use-rollback"
import { useDraftRecovery } from "../hooks/use-draft-recovery"
import { useAutoTrigger } from "../hooks/use-auto-trigger"
import { useSearchScroll } from "../hooks/use-search-scroll"
import { useKeyboardStop } from "../hooks/use-keyboard-stop"
import { useScrollInit } from "../hooks/use-scroll-init"
import { useCustomEventListeners } from "../hooks/use-custom-event-listeners"
import { useSidebarMutex } from "../hooks/use-sidebar-mutex"
import { useDiffSidebarConflicts } from "../hooks/use-diff-sidebar-conflicts"
import { useScrollToBottomShortcut } from "../hooks/use-scroll-to-bottom-shortcut"
import { useMessageSync } from "../hooks/use-message-sync"
import { useDiffCache } from "../hooks/use-diff-cache"
import { useMainChatInvocation } from "../hooks/use-main-chat-invocation"
import {
  DiffStateProvider,
  DiffSidebarRenderer,
  useDiffState,
} from "../components/diff/diff-components"
import { useFileChangeListener, useGitWatcher } from "../../../lib/hooks/use-file-change-listener"
import { useResolvedHotkeyDisplay } from "../../../lib/hotkeys"
import { appStore } from "../../../lib/jotai-store"
import { api } from "../../../lib/api-adapter"
import { trpc, trpcClient } from "../../../lib/trpc"
import { cn } from "../../../lib/utils"
import { isDesktopApp } from "../../../lib/utils/platform"
import { ChangesPanel } from "../../changes"
import { useCommitActions } from "../../changes/components/commit-input"
import { DiffCenterPeekDialog } from "../../changes/components/diff-center-peek-dialog"
import { DiffFullPageView } from "../../changes/components/diff-full-page-view"
import { DiffSidebarHeader } from "../../changes/components/diff-sidebar-header"
import { usePushAction } from "../../changes/hooks/use-push-action"
import { getStatusIndicator } from "../../changes/utils/status"
import {
  detailsSidebarOpenAtom,
  detailsSidebarTabAtom,
  sideChatSidebarOpenAtom,
  unifiedSidebarEnabledAtom,
} from "../../details-sidebar/atoms"
import { DetailsSidebar } from "../../details-sidebar/details-sidebar"
import { SideChatSidebar } from "../../details-sidebar/components/side-chat-sidebar"
import {
  createPanelLinkScopeKey,
  panelLinkCommandAtomFamily,
} from "@/features/panel-link"
import { FileViewerSidebar } from "../../file-viewer"
import { FileSearchDialog } from "../../file-viewer/components/file-search-dialog"
import { terminalBottomHeightAtom, terminalDisplayModeAtom, terminalSidebarOpenAtomFamily } from "../../terminal/atoms"
import { TerminalBottomPanelContent, TerminalSidebar } from "../../terminal/terminal-sidebar"
import { getTerminalScopeKey } from "../../terminal/utils"
import {
  agentsChangesPanelCollapsedAtom,
  agentsChangesPanelWidthAtom,
  agentsDiffSidebarWidthAtom,
  agentsPlanSidebarWidthAtom,
  agentsPreviewSidebarOpenAtom,
  agentsPreviewSidebarWidthAtom,
  agentsConversationsSidebarModeAtom,
  agentsConversationUnseenChangesAtom,
  agentsUnseenChangesAtom,
  clearLoading,
  compactingConversationsAtom,
  currentPlanPathAtomFamily,
  diffActiveTabAtom,
  diffSidebarOpenAtomFamily,
  diffViewDisplayModeAtom,
  expiredUserQuestionsAtom,
  fileSearchDialogOpenAtom,
  fileViewerDisplayModeAtom,
  fileViewerOpenAtomFamily,
  fileViewerSidebarWidthAtom,
  filteredDiffFilesAtom,
  filteredConversationIdAtom,
  isCreatingPrAtom,
  justCreatedIdsAtom,
  loadingConversationsAtom,
  MODEL_ID_MAP,
  pendingAuthRetryMessageAtom,
  pendingBuildPlanConversationIdAtom,
  pendingConflictResolutionMessageAtom,
  pendingChatHistoryAtom,
  type PendingChatHistory,
  pendingMentionAtom,
  pendingPlanApprovalsAtom,
  pendingPrMessageAtom,
  pendingReviewMessageAtom,
  pendingUserQuestionsAtom,
  planSidebarOpenAtomFamily,
  QUESTIONS_SKIPPED_MESSAGE,
  selectedAgentChatIdAtom,
  selectedCommitAtom,
  selectedDiffFilePathAtom,
  setLoading,
  conversationFilesAtom,
  agentsSidebarOpenAtom,
  conversationCodexModelIdAtomFamily,
  conversationCodexThinkingAtomFamily,
  conversationModelIdAtomFamily,
  conversationModeAtomFamily,
  suppressInputFocusAtom,
  undoStackAtom,
  workspaceDiffCacheAtomFamily,
  type AgentMode,
  type SelectedCommit
} from "../atoms"
import { AgentSendButton } from "../components/agent-send-button"
import { PreviewSetupHoverCard } from "../components/preview-setup-hover-card"
import type { TextSelectionSource } from "../context/text-selection-context"
import { TextSelectionProvider } from "../context/text-selection-context"
import { useAgentsFileUpload, type UploadedImage } from "../hooks/use-agents-file-upload"
import { useAgentPlan } from "../hooks/use-agent-plan"
import { useChangedFilesTracking } from "../hooks/use-changed-files-tracking"
import { useDesktopNotifications } from "../hooks/use-desktop-notifications"
import { useFocusInputOnEnter } from "../hooks/use-focus-input-on-enter"
import { useHaptic } from "../hooks/use-haptic"
import { usePastedTextFiles, type PastedTextFile } from "../hooks/use-pasted-text-files"
import { useTextContextSelection } from "../hooks/use-text-context-selection"
import { useToggleFocusOnCmdEsc } from "../hooks/use-toggle-focus-on-cmd-esc"
import { usePendingAuthRetry } from "../hooks/use-pending-auth-retry"
import { useDiffSidebarWidth } from "../hooks/use-diff-sidebar-width"
import { useGitStatusSync } from "../hooks/use-git-status-sync"
import { useConversationShortcuts } from "../hooks/use-conversation-shortcuts"
import { useConversationStoreInit } from "../hooks/use-conversation-store-init"
import { useChatInstanceFactory } from "../hooks/use-chat-instance-factory"
import { ErgataiChatTransport } from "../lib/ergatai-chat-transport"
import { GroupChatTransport } from "../lib/group-chat-transport"
import { GroupChatProvider } from "../collaboration/group-chat-context"
import { CollaborationSessionEventCards } from "../collaboration/collaboration-session-event-cards"
import {
  isCollaborationSessionRuntimeEnabled,
  useCollaborationSession,
} from "../collaboration/collaboration-session-runtime"
import { extractAgentMentions } from "../collaboration/implicit-collaboration"
import { ImplicitCollaborationTaskCards } from "../collaboration/implicit-collaboration-task-cards"
import {
  setGroupAgentRuntimeStatuses,
  type GroupAgentRuntimeStatuses,
} from "../collaboration/group-agent-runtime"
import { useAgentParticipants } from "../collaboration/use-agent-participants"
import { useImplicitCollaborationTasks } from "../collaboration/use-implicit-collaboration-tasks"
import { loadGroupAgents } from "../collaboration/group-agent-storage"
import {
  getCoreAgentProfileName,
  type CoreAgentOption,
} from "../lib/agent-contract-api"
import { formatHistoryForContext } from "../lib/export-chat"
import {
  clearConversationDraft,
  getConversationDraftFull
} from "../lib/drafts"
import {
  createQueueItem, createTextPreview, generateQueueId,
  toQueuedFile,
  toQueuedImage,
  toQueuedTextContext, toQueuedDiffTextContext, toQueuedPastedText, type DiffTextContext, type SelectedTextContext
} from "../lib/queue-utils"
import { isMockChatEnabled, MockChatTransport } from "../lib/mock-chat-transport"
import {
  FileOpenProvider,
  MENTION_PREFIXES,
  type AgentsMentionsEditorHandle,
} from "../mentions"
import {
  ChatSearchBar,
  chatSearchCurrentMatchAtom,
  SearchHighlightProvider
} from "../search"
import { agentChatStore } from "../stores/agent-chat-store"
import { EMPTY_QUEUE, useMessageQueueStore } from "../stores/message-queue-store"
import {
  findRollbackTargetSdkUuidForUserIndex,
  isRollingBackAtom,
  syncMessagesWithStatusAtom
} from "../stores/message-store"
import { clearConversationRuntimeCaches } from "../stores/conversation-runtime-cleanup"
import { useStreamingStatusStore } from "../stores/streaming-status-store"
import {
  useAgentConversationStore,
  type ConversationMeta,
} from "../stores/conversation-store"
import type { DiffViewMode } from "../ui/agent-diff-view"
import {
  AgentDiffView,
  diffViewModeAtom,
  splitUnifiedDiffByFile,
  type AgentDiffViewRef,
  type ParsedDiffFile,
} from "../ui/agent-diff-view"
import { AgentPlanSidebar } from "../ui/agent-plan-sidebar"
import { AgentPreview } from "../ui/agent-preview"
import { AgentQueueIndicator } from "../ui/agent-queue-indicator"
import { isPlanFile } from "../ui/agent-tool-utils"
import { AgentUserQuestion, type AgentUserQuestionHandle } from "../ui/agent-user-question"
import { PermissionApprovalPanel } from "../../../components/dialogs/permission-approval-dialog"
import { AgentsHeaderControls } from "../ui/agents-header-controls"
import { ChatTitleEditor } from "../ui/chat-title-editor"
import { MobileChatHeader } from "../ui/mobile-chat-header"
import { QuickCommentInput } from "../ui/quick-comment-input"
import { ConversationSelector } from "../ui/conversation-selector"
import { ConversationStatusCard } from "../ui/conversation-status-card"
import { SplitViewContainer } from "../ui/split-view-container"
import { TextSelectionPopover } from "../ui/text-selection-popover"
import { generateCommitToPrMessage, generatePrMessage, generateReviewMessage } from "../utils/pr-message"
import { ChatInputArea } from "./chat-input-area"
import { ChatMessagesRenderer } from "./chat-messages-renderer"
import { MessageGroup } from "./message-group"
const clearConversationSelectionAtom = atom(null, () => {})
const isConversationMultiSelectModeAtom = atom(false)
const selectedConversationIdsAtom = atom(new Set<string>())
// import { selectedTeamIdAtom } from "@/lib/atoms/team"
const selectedTeamIdAtom = atom<string | null>(null)
// import type { PlanType } from "@/lib/config/subscription-plans"
type PlanType = string

// Module-level scroll position cache moved to use-scroll-management hook
const mountedChatViewInnerCounts = new Map<string, number>()
const pendingConversationCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>()

function clearRuntimeCachesForConversation(conversationId: string) {
  clearConversationRuntimeCaches(conversationId)
  // scrollPositionCache is now managed in use-scroll-management hook
}

import { utf8ToBase64, base64ToUtf8 } from "../utils/base64"

// Exploring tools - these get grouped when 2+ consecutive
const EXPLORING_TOOLS = new Set([
  "tool-Read",
  "tool-Grep",
  "tool-Glob",
  "tool-WebSearch",
  "tool-WebFetch",
])

// Group consecutive exploring tools into exploring-group
function groupExploringTools(parts: any[], nestedToolIds: Set<string>): any[] {
  const result: any[] = []
  let currentGroup: any[] = []

  for (const part of parts) {
    // Skip nested tools - they shouldn't be grouped, they render inside parent
    const isNested = part.toolCallId && nestedToolIds.has(part.toolCallId)

    if (EXPLORING_TOOLS.has(part.type) && !isNested) {
      currentGroup.push(part)
    } else {
      // Flush group if 3+
      if (currentGroup.length >= 3) {
        result.push({ type: "exploring-group", parts: currentGroup })
      } else {
        result.push(...currentGroup)
      }
      currentGroup = []
      result.push(part)
    }
  }
  // Flush remaining
  if (currentGroup.length >= 3) {
    result.push({ type: "exploring-group", parts: currentGroup })
  } else {
    result.push(...currentGroup)
  }
  return result
}

// Get the ID of the first conversation by creation date
function getFirstConversationId(
  conversations:
    | Array<{ id: string; created_at?: Date | string | null }>
    | undefined,
): string | null {
  if (!conversations?.length) return null
  const sorted = [...conversations].sort(
    (a, b) =>
      (a.created_at ? new Date(a.created_at).getTime() : 0) -
      (b.created_at ? new Date(b.created_at).getTime() : 0),
  )
  return sorted[0]?.id ?? null
}

// Layout constants for chat header and sticky messages
const CHAT_LAYOUT = {
  // Padding top for chat content
  paddingTopSidebarOpen: "pt-12", // When sidebar open (absolute header overlay)
  paddingTopSidebarClosed: "pt-4", // When sidebar closed (regular header)
  paddingTopMobile: "pt-14", // Mobile has header
  // Sticky message top position (title is now in flex above scroll, so top-0)
  stickyTopSidebarOpen: "top-0", // When sidebar open (desktop, absolute header)
  stickyTopSidebarClosed: "top-0", // When sidebar closed (desktop, flex header)
  stickyTopMobile: "top-0", // Mobile (flex header, so top-0)
  // Header padding when absolute
  headerPaddingSidebarOpen: "pt-1.5 pb-12 px-3 pl-2",
  headerPaddingSidebarClosed: "p-2 pt-1.5",
} as const

// Codex icon (OpenAI style)
const CodexIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
    <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08-4.778 2.758a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z" />
  </svg>
)

// Agent providers
const agents = [
  { id: "claude-code", name: "Claude Code", hasModels: true },
  { id: "cursor", name: "Cursor CLI", disabled: true },
  { id: "codex", name: "OpenAI Codex", disabled: true },
]

// Helper function to get agent icon
const getAgentIcon = (agentId: string, className?: string) => {
  switch (agentId) {
    case "claude-code":
      return <ClaudeCodeIcon className={className} />
    case "cursor":
      return <CursorIcon className={className} />
    case "codex":
      return <CodexIcon className={className} />
    default:
      return null
  }
}

// Copy button component with tooltip feedback (matches project style)
function CopyButton({
  onCopy,
  isMobile = false,
}: {
  onCopy: () => void
  isMobile?: boolean
}) {
  const [copied, setCopied] = useState(false)
  const { trigger: triggerHaptic } = useHaptic()

  const handleCopy = () => {
    onCopy()
    triggerHaptic("medium")
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <button
      onClick={handleCopy}
      tabIndex={-1}
      className="p-1.5 rounded-md transition-[background-color,transform] duration-150 ease-out hover:bg-accent active:scale-[0.97]"
    >
      <div className="relative w-3.5 h-3.5">
        <CopyIcon
          className={cn(
            "absolute inset-0 w-3.5 h-3.5 text-muted-foreground transition-[opacity,transform] duration-200 ease-out",
            copied ? "opacity-0 scale-50" : "opacity-100 scale-100",
          )}
        />
        <CheckIcon
          className={cn(
            "absolute inset-0 w-3.5 h-3.5 text-muted-foreground transition-[opacity,transform] duration-200 ease-out",
            copied ? "opacity-100 scale-100" : "opacity-0 scale-50",
          )}
        />
      </div>
    </button>
  )
}

// Isolated scroll-to-bottom button - uses own scroll listener to avoid re-renders of parent
const ScrollToBottomButton = memo(function ScrollToBottomButton({
  containerRef,
  onScrollToBottom,
  hasStackedCards = false,
  conversationId,
  isActive = true,
  isSplitPane = false,
}: {
  containerRef: React.RefObject<HTMLElement | null>
  onScrollToBottom: () => void
  hasStackedCards?: boolean
  conversationId?: string
  isActive?: boolean
  isSplitPane?: boolean
}) {
  const [isVisible, setIsVisible] = useState(false)
  const shouldMonitor = isActive || isSplitPane

  // Keep current monitoring state in ref for scroll event handler
  const shouldMonitorRef = useRef(shouldMonitor)
  shouldMonitorRef.current = shouldMonitor

  useEffect(() => {
    // Skip scroll monitoring for tabs that are not visible (keep-alive)
    if (!shouldMonitor) return

    const container = containerRef.current
    if (!container) return

    // RAF throttle to avoid setState on every scroll event
    let rafId: number | null = null
    let lastAtBottom: boolean | null = null

    const checkVisibility = () => {
      // Skip if tab is not visible or RAF already pending
      if (!shouldMonitorRef.current || rafId !== null) return

      rafId = requestAnimationFrame(() => {
        rafId = null
        // Double-check current monitoring state in RAF callback
        if (!shouldMonitorRef.current) return

        const threshold = 50
        const atBottom =
          container.scrollHeight - container.scrollTop - container.clientHeight <=
          threshold

        // Only update state if value actually changed
        if (lastAtBottom !== atBottom) {
          lastAtBottom = atBottom
          setIsVisible(!atBottom)
        }
      })
    }

    // Check initial state after a short delay to allow scroll position to be set
    // This handles the case when entering a conversation that's scrolled to a specific position
    const timeoutId = setTimeout(() => {
      // Skip if tab is not visible
      if (!shouldMonitorRef.current) return

      // Direct check for initial state (no RAF needed)
      const threshold = 50
      const atBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight <=
        threshold
      lastAtBottom = atBottom
      setIsVisible(!atBottom)
    }, 50)

    container.addEventListener("scroll", checkVisibility, { passive: true })
    return () => {
      clearTimeout(timeoutId)
      if (rafId !== null) cancelAnimationFrame(rafId)
      container.removeEventListener("scroll", checkVisibility)
    }
  }, [containerRef, conversationId, shouldMonitor])

  return (
    <AnimatePresence>
      {isVisible && (
        <Tooltip delayDuration={300}>
          <TooltipTrigger asChild>
            <motion.button
              initial={{ opacity: 0, scale: 0.96, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 8 }}
              transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}
              onClick={onScrollToBottom}
              className={cn(
                "absolute p-2 rounded-full bg-background border border-border shadow-md hover:bg-accent active:scale-[0.97] transition-[color,background-color,bottom] duration-200 z-20",
              )}
              style={{
                right: "0.75rem",
                // Wide screen (container > 48rem): button sits in bottom-right corner
                // Narrow screen (container <= 48rem): button lifts above the input
                bottom: "clamp(0.75rem, (48rem - var(--chat-container-width, 0px)) * 1000, calc(var(--chat-input-height, 4rem) + 1rem))",
              }}
              aria-label="Scroll to bottom"
            >
              <ArrowDown className="h-4 w-4 text-muted-foreground" />
            </motion.button>
          </TooltipTrigger>
          <TooltipContent side="top">
            Scroll to bottom
            <span className="inline-flex items-center gap-0.5">
              <Kbd>⌘</Kbd>
              <Kbd>
                <ArrowDown className="h-3 w-3" />
              </Kbd>
            </span>
          </TooltipContent>
        </Tooltip>
      )}
    </AnimatePresence>
  )
})

// Collapsible steps component for intermediate content before final response
interface CollapsibleStepsProps {
  stepsCount: number
  children: React.ReactNode
  defaultExpanded?: boolean
}

function CollapsibleSteps({
  stepsCount,
  children,
  defaultExpanded = false,
}: CollapsibleStepsProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded)

  if (stepsCount === 0) return null

  return (
    <div className="mb-2" data-collapsible-steps="true">
      {/* Header row - styled like AgentToolCall with expand icon on right */}
      <div
        className="flex items-center justify-between rounded-md py-0.5 px-2 cursor-pointer hover:bg-muted/50 transition-colors"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <ListTree className="w-3.5 h-3.5 flex-shrink-0" />
          <span className="font-medium whitespace-nowrap">
            {stepsCount} {stepsCount === 1 ? "step" : "steps"}
          </span>
        </div>
        <button
          className="p-1 rounded-md hover:bg-accent transition-[background-color,transform] duration-150 ease-out active:scale-95"
          onClick={(e) => {
            e.stopPropagation()
            setIsExpanded(!isExpanded)
          }}
        >
          <div className="relative w-4 h-4">
            <ExpandIcon
              className={cn(
                "absolute inset-0 w-4 h-4 text-muted-foreground transition-[opacity,transform] duration-200 ease-out",
                isExpanded ? "opacity-0 scale-75" : "opacity-100 scale-100",
              )}
            />
            <CollapseIcon
              className={cn(
                "absolute inset-0 w-4 h-4 text-muted-foreground transition-[opacity,transform] duration-200 ease-out",
                isExpanded ? "opacity-100 scale-100" : "opacity-0 scale-75",
              )}
            />
          </div>
        </button>
      </div>
      {isExpanded && children}
    </div>
  )
}

// Inner chat component - only rendered when chat object is ready
// Memoized to prevent re-renders when parent state changes (e.g., selectedFilePath)
const ChatViewInner = memo(function ChatViewInner({
  chat,
  conversationId,
  parentChatId,
  provider = "claude-code",
  isFirstConversation,
  onCreateNewConversation,
  onProviderChange,
  refreshDiff,
  teamId,
  repository,
  isMobile = false,
  sandboxSetupStatus = "ready",
  sandboxSetupError,
  onRetrySetup,
  isConversationsSidebarOpen = false,
  sandboxId,
  projectPath,
  isArchived = false,
  onRestoreWorkspace,
  existingPrUrl,
  isActive = true,
  isSplitPane = false,
  isGroupMode = false,
  workspaceName,
  workspaceBranch,
  workspaceRepoName,
  workspaceId,
  projectId,
}: {
  chat: Chat<any>
  conversationId: string
  parentChatId: string
  provider?: "claude-code" | "codex"
  isFirstConversation: boolean
  onCreateNewConversation?: () => void
  onProviderChange?: (
    conversationId: string,
    provider: "claude-code" | "codex",
  ) => void
  refreshDiff?: () => void
  teamId?: string
  repository?: string
  isMobile?: boolean
  sandboxSetupStatus?: "cloning" | "ready" | "error"
  sandboxSetupError?: string
  onRetrySetup?: () => void
  isConversationsSidebarOpen?: boolean
  sandboxId?: string
  projectPath?: string
  isArchived?: boolean
  onRestoreWorkspace?: () => void
  existingPrUrl?: string | null
  isActive?: boolean
  isSplitPane?: boolean
  isGroupMode?: boolean
  workspaceName?: string | null
  workspaceBranch?: string | null
  workspaceRepoName?: string | null
  workspaceId?: string | null
  projectId?: string | null
}) {
  const [groupAgents, setGroupAgents] = useState<CoreAgentOption[]>([])

  useEffect(() => {
    setGroupAgents(isGroupMode ? loadGroupAgents(parentChatId) : [])
  }, [isGroupMode, parentChatId])

  const handleGroupAgentsChange = useCallback((agents: CoreAgentOption[]) => {
    setGroupAgents(agents)
  }, [])

  const groupContextValue = useMemo(
    () => ({ agents: groupAgents, isGroupChat: isGroupMode }),
    [groupAgents, isGroupMode],
  )
  const agentParticipants = useAgentParticipants({
    chatId: parentChatId,
    workspaceId: projectPath || null,
    runtimeWorkspaceId: workspaceId || null,
    supervisorAgentId: isGroupMode ? null : provider,
  })
  const implicitCollaborationTasks = useImplicitCollaborationTasks(
    conversationId,
  )

  const hasTriggeredAutoGenerateRef = useRef(false)
  const isVisiblePane = isActive || isSplitPane

  // Keep isActive in ref for use in callbacks (avoid stale closures)
  const isVisiblePaneRef = useRef(isVisiblePane)
  isVisiblePaneRef.current = isVisiblePane

  // Phase 10.3: Bridge hook for progressive migration to ConversationInvocationService
  // This hook combines the existing Chat instance (for message rendering) with
  // useConversationInvocation (for queue management)
  // Phase 16: Pass existing chat instance to avoid creating duplicate
  const conversationForBridge = useMemo(() => ({
    id: conversationId,
    backendConversationId: conversationId,
  }), [conversationId])

  const chatInvocation = useMainChatInvocation({
    conversation: conversationForBridge as any,
    chatId: parentChatId,
    agentId: provider,
    isActive,
    existingChat: chat, // Pass existing Chat instance to avoid duplicate
  })

  // Extract session state for future migration
  const { sessionState, invocationQueue } = chatInvocation

  // Scroll management - handles auto-scroll, position tracking, and animation
  const {
    shouldAutoScrollRef,
    isAutoScrollingRef,
    isInitializingScrollRef,
    scrollInitializedRef,
    hasUnapprovedPlanRef,
    chatContainerRef,
    chatContainerObserverRef,
    contentWrapperRef,
    prevScrollTopRef,
    saveScrollPosition,
    isAtBottom,
    handleScroll,
    scrollToBottom,
  } = useScrollManagement({
    conversationId,
    isVisiblePane,
    isVisiblePaneRef,
  })

  const editorRef = useRef<AgentsMentionsEditorHandle>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const questionRef = useRef<AgentUserQuestionHandle>(null)
  const prevChatKeyRef = useRef<string | null>(null)
  const prevConversationIdRef = useRef<string | null>(null)

  // Consume pending mentions from external components (e.g. MCP widget in sidebar)
  const [pendingMention, setPendingMention] = useAtom(pendingMentionAtom)
  useEffect(() => {
    // Only active pane should consume a global pending mention.
    // This prevents duplicate insertion across keep-alive/split panes.
    if (!isActive || !pendingMention) return
    editorRef.current?.insertMention(pendingMention)
    editorRef.current?.focus()
    setPendingMention(null)
  }, [isActive, pendingMention, setPendingMention])


  // Rollback state (global atom to prevent multiple rollbacks across chats)
  const [isRollingBack, setIsRollingBack] = useAtom(isRollingBackAtom)

  // tRPC utils for cache invalidation
  const utils = api.useUtils()

  // Get conversation name from store
  const conversationName = useAgentConversationStore(
    (state) => state.allConversations.find((sc) => sc.id === conversationId)?.name || "",
  )

  // Mutation for renaming conversation
  const renameConversationMutation = api.agents.renameConversation.useMutation({
    onError: (error) => {
      if (error.data?.code === "NOT_FOUND") {
        toast.error("Send a message first before renaming this chat")
      } else {
        toast.error("Failed to rename chat")
      }
    },
  })

  // Handler for renaming conversation
  // Using ref for mutation to avoid callback recreation
  const renameConversationMutationRef = useRef(renameConversationMutation)
  renameConversationMutationRef.current = renameConversationMutation
  const conversationNameRef = useRef(conversationName)
  conversationNameRef.current = conversationName

  const handleRenameConversation = useCallback(
    async (newName: string) => {
      // Optimistic update in store
      useAgentConversationStore.getState().updateConversationName(conversationId, newName)

      // Save to database
      try {
        await renameConversationMutationRef.current.mutateAsync({
          conversationId: conversationId,
          title: newName,
        })
      } catch {
        // Revert on error (toast shown by mutation onError)
        useAgentConversationStore
          .getState()
          .updateConversationName(conversationId, conversationNameRef.current || "New Chat")
      }
    },
    [conversationId],
  )

  // Plan mode state (per-conversation? using atomFamily)
  const [conversationMode, setConversationMode] = useAtom(conversationModeAtomFamily(conversationId))

  // Mutation for updating conversation mode in database
  const updateConversationModeMutation = api.agents.updateConversationMode.useMutation({
    onSuccess: () => {
      // Invalidate to refetch with new mode from DB
      utils.agents.getAgentChat.invalidate({ chatId: parentChatId })
    },
    onError: (error, variables) => {
      // Don't revert if conversation not found in DB - it may not be persisted yet
      // This is expected for new conversations that haven't been saved to DB
      if (error.message === "Conversation not found") {
        console.warn("Conversation not found in DB, keeping local mode state")
        return
      }

      // Revert local state on error to maintain sync with database
      const revertedMode: AgentMode = variables.mode === "plan" ? "agent" : "plan"
      setConversationMode(revertedMode)
      // Also update store for consistency
      useAgentConversationStore
        .getState()
        .updateConversationMode(variables.conversationId, revertedMode)
      console.error("Failed to update conversation mode:", error.message)
    },
  })

  // Sync atomFamily mode to Zustand store on mount/conversationId change
  // This ensures the sidebar shows the correct mode icon
  useEffect(() => {
    if (conversationId) {
      // Read mode directly from atomFamily to ensure we get the correct value
      const mode = appStore.get(conversationModeAtomFamily(conversationId))
      useAgentConversationStore.getState().updateConversationMode(conversationId, mode)
    }
  }, [conversationId])

  // NOTE: We no longer clear caches on deactivation.
  // With proper conversationId isolation, each chat's caches are separate.
  // Caches are only cleared when no ChatViewInner instance is mounted for this conversation.
  useEffect(() => {
    const prevCount = mountedChatViewInnerCounts.get(conversationId) ?? 0
    const nextCount = prevCount + 1
    mountedChatViewInnerCounts.set(conversationId, nextCount)

    const pendingCleanup = pendingConversationCleanupTimers.get(conversationId)
    if (pendingCleanup) {
      clearTimeout(pendingCleanup)
      pendingConversationCleanupTimers.delete(conversationId)
    }

    return () => {
      const currentCount = mountedChatViewInnerCounts.get(conversationId) ?? 0
      const remainingCount = Math.max(0, currentCount - 1)
      if (remainingCount === 0) {
        mountedChatViewInnerCounts.delete(conversationId)
      } else {
        mountedChatViewInnerCounts.set(conversationId, remainingCount)
      }

      if (remainingCount > 0) {
        return
      }

      const existingTimeoutId = pendingConversationCleanupTimers.get(conversationId)
      if (existingTimeoutId) {
        clearTimeout(existingTimeoutId)
      }

      const timeoutId = setTimeout(() => {
        pendingConversationCleanupTimers.delete(conversationId)
        const mountedCountNow = mountedChatViewInnerCounts.get(conversationId) ?? 0

        if (mountedCountNow > 0) {
          return
        }

        const currentConversationState = useAgentConversationStore.getState()
        if (currentConversationState.activeConversationId === conversationId) return
        if (useStreamingStatusStore.getState().isStreaming(conversationId)) return
        if ((useMessageQueueStore.getState().queues[conversationId]?.length ?? 0) > 0) return

        clearRuntimeCachesForConversation(conversationId)
      }, 100)

      pendingConversationCleanupTimers.set(conversationId, timeoutId)
    }
  }, [conversationId])

  // Handle mode changes - updates atomFamily, store, and database together
  // No effect needed - this is called directly when user toggles mode
  const handleModeChange = useCallback((newMode: AgentMode) => {
    // Update atomFamily (source of truth for UI)
    setConversationMode(newMode)

    // Update Zustand store (for other components that read from store)
    useAgentConversationStore.getState().updateConversationMode(conversationId, newMode)

    // Save to database (skip temp IDs that haven't been persisted yet)
    if (!conversationId.startsWith("temp-")) {
      updateConversationModeMutation.mutate({ conversationId, mode: newMode })
    }
  }, [conversationId, setConversationMode, updateConversationModeMutation])

  // File/image upload hook
  const {
    images,
    files,
    handleAddAttachments,
    handleAddFolder,
    removeImage,
    removeFile,
    clearAll,
    isUploading,
    setImagesFromDraft,
    setFilesFromDraft,
  } = useAgentsFileUpload()

  // Text context selection hook (for selecting text from assistant messages and diff)
  const {
    textContexts,
    diffTextContexts,
    addTextContext: addTextContextOriginal,
    addDiffTextContext,
    removeTextContext,
    removeDiffTextContext,
    clearTextContexts,
    clearDiffTextContexts,
    textContextsRef,
    diffTextContextsRef,
    setTextContextsFromDraft,
    setDiffTextContextsFromDraft,
  } = useTextContextSelection()

  // Pasted text files (large pasted text saved as files)
  const {
    pastedTexts,
    addPastedText,
    addChatHistoryFile,
    removePastedText,
    clearPastedTexts,
    pastedTextsRef,
    setPastedTextsFromDraft,
  } = usePastedTextFiles(conversationId)

  // Consume pending chat history file when this conversation is the target
  useEffect(() => {
    const pending = appStore.get(pendingChatHistoryAtom)
    if (pending && pending.conversationId === conversationId) {
      addChatHistoryFile(pending.file)
      appStore.set(pendingChatHistoryAtom, null)
    }
  }, [conversationId, addChatHistoryFile])

  // File contents cache - stores content for file mentions (keyed by mentionId)
  // This content gets added to the prompt when sending, without showing a separate card
  const fileContentsRef = useRef<Map<string, string>>(new Map())
  const cacheFileContent = useCallback((mentionId: string, content: string) => {
    fileContentsRef.current.set(mentionId, content)
  }, [])
  const clearFileContents = useCallback(() => {
    fileContentsRef.current.clear()
  }, [])

  // Clear file contents cache when switching conversations to prevent stale data
  useEffect(() => {
    fileContentsRef.current.clear()
  }, [conversationId])

  // Phase 18: Use service-based queue system
  // Convert ConversationQueueItem[] to AgentQueueItem[] for UI compatibility
  // Use a ref to cache the previous conversion and only update when content actually changes
  const queueCacheRef = useRef<{
    items: typeof invocationQueue
    result: any[]
  } | null>(null)

  const queue = useMemo(() => {
    // Check if we can reuse the cached result
    if (
      queueCacheRef.current &&
      queueCacheRef.current.items === invocationQueue &&
      queueCacheRef.current.items.length === invocationQueue.length
    ) {
      return queueCacheRef.current.result
    }

    // Convert items
    const result = invocationQueue.map((item) => {
      // Extract data from parts to reconstruct AgentQueueItem
      const parts = item.originalInput.parts || []

      const textPart = parts.find((p: any) => p.type === "text")
      const imageParts = parts.filter((p: any) => p.type === "data-image")
      const fileParts = parts.filter((p: any) => p.type === "data-file")

      return {
        id: item.id,
        message: textPart?.text || "",
        images: imageParts.map((p: any, idx: number) => ({
          id: `img_${item.id}_${idx}`,
          url: p.data?.url || "",
          mediaType: p.data?.mediaType || "image/png",
          filename: p.data?.filename || "image.png",
          base64Data: p.data?.base64Data,
          isLoading: false,
          preview: p.data?.url || "",
        })),
        files: fileParts.map((p: any, idx: number) => ({
          id: `file_${item.id}_${idx}`,
          url: p.data?.url || "",
          mediaType: p.data?.mediaType || "application/octet-stream",
          filename: p.data?.filename || "file",
          size: p.data?.size || 0,
          isLoading: false,
          preview: p.data?.filename || "file",
        })),
        // Note: textContexts, diffText contexts, pastedTexts are encoded as mention tokens in message
        // They will be decoded by the backend when processing the message
        timestamp: item.queuedAt,
        status: item.status,
      }
    })

    // Cache the result
    queueCacheRef.current = { items: invocationQueue, result }

    return result
  }, [invocationQueue])

  const addToQueue = chatInvocation.service?.enqueue
  const removeFromQueue = chatInvocation.removeQueuedItem
  const popItemFromQueue = chatInvocation.removeQueuedItem // Same as remove for now

  // Plan approval pending state (for tool approval loading)
  const [planApprovalPending, setPlanApprovalPending] = useState<
    Record<string, boolean>
  >({})

  // Track chat changes for rename trigger reset
  const chatRef = useRef<Chat<any> | null>(null)

  if (prevConversationIdRef.current !== conversationId) {
    hasTriggeredAutoGenerateRef.current = false // Reset auto-generate on conversation change
    prevConversationIdRef.current = conversationId
  }
  chatRef.current = chat

  // Restore draft when conversationId changes (switching between conversations)
  useDraftRecovery({
    conversationId,
    parentChatId,
    editorRef,
    setImagesFromDraft,
    setFilesFromDraft,
    setTextContextsFromDraft,
    clearAll,
    clearTextContexts,
  })

  // Use conversationId as stable key to prevent HMR-induced duplicate resume requests
  const { messages, sendMessage, status, stop, regenerate, setMessages } = useChat({
    id: conversationId,
    chat,
    experimental_throttle: 50,  // Throttle updates to reduce re-renders during streaming
  })

  // Refs for useChat functions to keep callbacks stable across renders
  const sendMessageRef = useRef(sendMessage)
  sendMessageRef.current = sendMessage
  const stopRef = useRef(stop)
  stopRef.current = stop

  const isStreaming = status === "streaming" || status === "submitted"

  // Ref for isStreaming to use in callbacks/effects that need fresh value
  const isStreamingRef = useRef(isStreaming)
  isStreamingRef.current = isStreaming

  // Fetch plan from backend API instead of scanning messages
  const currentPlanPathAtom = useMemo(
    () => currentPlanPathAtomFamily(conversationId),
    [conversationId],
  )
  const [, setCurrentPlanPath] = useAtom(currentPlanPathAtom)

  const {
    planPath: apiPlanPath,
    isLoading: planLoading,
    refetch: refetchPlan,
  } = useAgentPlan({
    chatId: parentChatId,
    conversationId,
    enabled: !!conversationId,
  })

  // Update atom when API returns plan path
  useEffect(() => {
    if (apiPlanPath) {
      setCurrentPlanPath(apiPlanPath)
    } else if (!planLoading) {
      setCurrentPlanPath(null)
    }
  }, [apiPlanPath, planLoading, setCurrentPlanPath])

  // Refetch plan when streaming completes
  useEffect(() => {
    if (status === "ready" && conversationId) {
      refetchPlan()
    }
  }, [status, conversationId, refetchPlan])

  // Listen for plan update events from AgentPlanFileTool
  useEffect(() => {
    const handlePlanUpdate = (event: Event) => {
      const customEvent = event as CustomEvent<{ conversationId: string; filePath: string }>
      if (customEvent.detail.conversationId === conversationId) {
        refetchPlan()
      }
    }

    window.addEventListener("plan-updated", handlePlanUpdate)
    return () => window.removeEventListener("plan-updated", handlePlanUpdate)
  }, [conversationId, refetchPlan])

  // Collaboration participants - creates conversations for each agent in group mode
  const {
    collaborationParticipants,
    collaborationSessionEnabled,
  } = useCollaborationParticipants({
    collaborationSessionEnabled: isCollaborationSessionRuntimeEnabled(),
    isGroupMode,
    groupAgents,
    workspaceId: workspaceId ?? null,
    parentChatId,
    conversationId,
    provider,
  })

  const collaborationSession = useCollaborationSession({
    chatId: parentChatId,
    conversationId,
    mode: isGroupMode ? "group" : "supervisor",
    workspaceId,
    projectId,
    participants: collaborationParticipants,
    enabled: collaborationSessionEnabled && !isArchived,
    pollingEnabled: collaborationSessionEnabled && isVisiblePane,
  })

  // Track compacting status from SDK
  const compactingConversations = useAtomValue(compactingConversationsAtom)
  const isCompacting = compactingConversations.has(conversationId)

  // Desktop/fullscreen state for window drag region
  const isDesktop = useAtomValue(isDesktopAtom)
  const isFullscreen = useAtomValue(isFullscreenAtom)

  // Handler to trigger manual context compaction
  const handleCompact = useCallback(() => {
    if (isStreamingRef.current) return // Can't compact while streaming
    sendMessageRef.current({
      role: "user",
      parts: [{ type: "text", text: "/compact" }],
    })
  }, [])

  // Handler to stop streaming - memoized to prevent ChatInputArea re-renders
  const handleStop = useCallback(async () => {
    // Mark as manually aborted to prevent completion sound
    agentChatStore.setManuallyAborted(conversationId, true)
    await stopRef.current()
  }, [conversationId])

  // Wrapper for addTextContext that handles TextSelectionSource
  const addTextContext = useCallback((text: string, source: TextSelectionSource) => {
    if (source.type === "assistant-message") {
      addTextContextOriginal(text, source.messageId)
    } else if (source.type === "diff") {
      addDiffTextContext(text, source.filePath, source.lineNumber, source.lineType)
    } else if (source.type === "tool-edit") {
      // Tool edit selections are treated as code selections (similar to diff)
      addDiffTextContext(text, source.filePath)
    } else if (source.type === "plan") {
      // Plan selections are treated as code selections (similar to diff)
      addDiffTextContext(text, source.planPath)
    } else if (source.type === "file-viewer") {
      // File viewer selections are treated as code selections
      addDiffTextContext(text, source.filePath)
    }
  }, [addTextContextOriginal, addDiffTextContext])

  // Focus handler for text selection popover - focus chat input after adding to context
  const handleFocusInput = useCallback(() => {
    editorRef.current?.focus()
  }, [])

  // Custom event listeners for file-viewer and file-tree interactions
  useCustomEventListeners({
    isActive,
    addTextContext,
    editorRef,
  })

  // Quick comment handlers
  const {
    quickCommentState,
    setQuickCommentState,
    handleQuickComment,
    handleQuickCommentSubmit,
    handleQuickCommentCancel,
  } = useQuickComment({
    conversationId,
    isStreamingRef,
    addToQueue,
    sendMessageRef,
  })

  // Auto-trigger: when a chat is loaded from DB with user messages but no assistant
  // messages, the initial message was saved by chats.create but the agent hasn't
  // been triggered. We use sendMessage to trigger the agent with real-time streaming.
  // To avoid duplicate user messages, we clear messages first, then trigger sendMessage
  // after the state update completes.
  const { autoTriggeredRef } = useAutoTrigger({
    conversationId,
    isStreaming,
    isGroupMode,
    messages,
    sendMessage,
    setMessages,
    hasTriggeredAutoGenerateRef,
  })

  // Sync loading status to atom for UI indicators
  // When streaming starts, set loading. When it stops, clear loading.
  // Unseen changes, sound notification, and sidebar refresh are handled in onFinish callback
  const setLoadingConversations = useSetAtom(loadingConversationsAtom)

  useEffect(() => {
    const storedParentChatId = agentChatStore.getParentChatId(conversationId)
    if (!storedParentChatId) return

    // For auto-triggered chats, keep loading state until the chat has assistant
    // messages (stream completed)
    const isAutoTriggered = autoTriggeredRef.current.has(conversationId)
    const hasAssistantMessages = messages.some((m) => m.role === "assistant")

    if (isStreaming) {
      setLoading(setLoadingConversations, conversationId, storedParentChatId)
    } else if (isAutoTriggered && !hasAssistantMessages) {
      // Auto-triggered but no assistant messages yet - keep loading state
      setLoading(setLoadingConversations, conversationId, storedParentChatId)
    } else {
      clearLoading(setLoadingConversations, conversationId)
    }
  }, [isStreaming, conversationId, setLoadingConversations, messages])

  // Extract pending actions into a hook
  const { isCreatingPr, setIsCreatingPr, pendingAuthRetry, setPendingAuthRetry } = usePendingActions({
    conversationId,
    isStreaming,
    sendMessage,
  })

  // Handle pending "Build plan" from sidebar (atom - effect is defined after handleApprovePlan)
  const [pendingBuildPlanConversationId, setPendingBuildPlanConversationId] = useAtom(
    pendingBuildPlanConversationIdAtom,
  )

  // Pending user questions from AskUserQuestion tool
  // Question handling and token data computation
  const {
    pendingQuestions,
    expiredQuestions,
    displayQuestions,
    isQuestionExpired,
    inputHasContent,
    setInputHasContent,
    lastAssistantMessage,
    messageTokenData,
    setPendingQuestionsMap,
    setExpiredQuestionsMap,
    recentlyStoppedStreamRef,
  } = useQuestionHandling({
    conversationId,
    isStreaming,
    messages,
    provider,
  })

  // Helper to clear pending and expired questions for this conversation? (used in callbacks)
  const clearPendingQuestionCallback = useCallback(() => {
    setPendingQuestionsMap((current) => {
      if (current.has(conversationId)) {
        const newMap = new Map(current)
        newMap.delete(conversationId)
        return newMap
      }
      return current
    })
    setExpiredQuestionsMap((current) => {
      if (current.has(conversationId)) {
        const newMap = new Map(current)
        newMap.delete(conversationId)
        return newMap
      }
      return current
    })
  }, [conversationId, setPendingQuestionsMap, setExpiredQuestionsMap])

  // Shared helpers for question answer handlers
  // Question answering handlers
  const {
    formatAnswersAsText,
    handleQuestionsAnswer,
    handleQuestionsSkip,
    handleSubmitWithQuestionAnswer,
    submitWithQuestionAnswerCallback,
    isSubmittingQuestionAnswerRef,
  } = useQuestionAnswers({
    displayQuestions,
    isQuestionExpired,
    conversationId,
    editorRef,
    questionRef,
    clearPendingQuestionCallback: () => {
      setPendingQuestionsMap((current) => {
        if (current.has(conversationId)) {
          const newMap = new Map(current)
          newMap.delete(conversationId)
          return newMap
        }
        return current
      })
    },
    clearInputAndDraft: () => {
      editorRef.current?.clear()
      if (parentChatId) {
        clearConversationDraft(parentChatId, conversationId)
      }
    },
    sendUserMessage: async (text: string) => {
      shouldAutoScrollRef.current = true
      await sendMessageRef.current({
        role: "user",
        parts: [{ type: "text", text }],
      })
    },
    isStreamingRef,
    stopRef,
    agentChatStore,
  })

  // Pending auth retry - retries sending message after OAuth success
  usePendingAuthRetry({
    pendingAuthRetry,
    conversationId,
    provider,
    isStreaming,
    sendMessage,
    setPendingAuthRetry,
  })

  // Plan approval handlers
  const { handlePlanApproval, handleApprovePlan } = usePlanApproval({
    conversationId,
    setConversationMode,
    scrollToBottom,
    updateConversationModeMutation,
    sendMessageRef,
  })

  // Handle pending "Build plan" from sidebar
  useEffect(() => {
    // Only trigger if this is the target conversation and we're active
    if (pendingBuildPlanConversationId === conversationId && isActive) {
      setPendingBuildPlanConversationId(null) // Clear immediately to prevent double-trigger
      handleApprovePlan()
    }
  }, [pendingBuildPlanConversationId, conversationId, isActive, setPendingBuildPlanConversationId, handleApprovePlan])

  // PR detection
  const { detectedPrUrlRef } = usePrDetection({
    messages,
    isStreaming,
    parentChatId,
    existingPrUrl,
    utils,
  })

  const { changedFiles: changedFilesForConversation, recomputeChangedFiles } = useChangedFilesTracking(
    messages,
    conversationId,
    isStreaming,
    parentChatId,
    projectPath,
  )

  // Rollback - handles rolling back to a previous message
  const { handleRollback } = useRollback({
    isRollingBack,
    setIsRollingBack,
    isStreaming,
    messages,
    setMessages,
    conversationId,
    recomputeChangedFiles,
    refreshDiff,
    setImagesFromDraft,
    setTextContextsFromDraft,
    setDiffTextContextsFromDraft,
    setPastedTextsFromDraft,
    editorRef,
  })

  // Fork handler - creates a new conversation with messages up to this point
  // Preserves SDK session context by copying .jsonl session files
  // Fork conversation - handles forking from a specific message
  const { handleForkFromMessage, isForkingRef } = useForkConversation({
    conversationId,
    parentChatId,
    isStreaming,
    messages,
    utils,
  })

  // Keyboard shortcuts for stopping stream (ESC, Ctrl+C, Cmd+Shift+Backspace)
  useKeyboardStop({
    isActive,
    isStreaming,
    conversationId,
    stop,
    displayQuestions,
    handleQuestionsSkip,
  })

  // Keyboard shortcut: Enter to focus input when not already focused
  useFocusInputOnEnter(editorRef, isActive)

  // Keyboard shortcut: Cmd+Esc to toggle focus/blur (without stopping generation)
  useToggleFocusOnCmdEsc(editorRef, isActive)

  // Auto-trigger AI response when we have initial message but no response yet
  // Also trigger auto-rename for initial conversation with pre-populated message
  useEffect(() => {
    if (
      (isGroupMode || messages.length === 1) &&
      status === "ready" &&
      !hasTriggeredAutoGenerateRef.current
    ) {
      hasTriggeredAutoGenerateRef.current = true
      regenerate()
    }
  }, [
    status,
    messages,
    regenerate,
    isFirstConversation,
    conversationId,
    isGroupMode,
  ])

  // Scroll initialization, auto-scroll, and position restoration
  useScrollInit({
    conversationId,
    isVisiblePane,
    isActive,
    isMobile,
    chatContainerRef,
    contentWrapperRef,
    shouldAutoScrollRef,
    isAutoScrollingRef,
    isInitializingScrollRef,
    scrollInitializedRef,
    prevScrollTopRef,
    scrollToBottom,
    handleScroll,
    status,
    messages,
    editorRef,
  })

  // Message sending handlers
  // Phase 10.3: Currently using useMessageSending for complex logic (inputRefs, actions, queue, messaging).
  // Future phases will migrate to chatInvocation.handleSend and chatInvocation.handleSendFromQueue
  // as the bridge hook matures to support all the required features.
  const {
    handleSend,
    handleSendFromQueue,
    handleRemoveFromQueue,
    handleForceSend,
  } = useMessageSending({
    conversation: {
      id: conversationId,
      parentChatId,
      mode: conversationMode,
      isArchived,
    },
    workspace: {
      sandboxSetupStatus,
      isGroupMode,
      teamId: teamId ?? null,
      projectPath: projectPath ?? null,
      workspaceId: workspaceId ?? null,
      provider,
    },
    collaboration: {
      session: collaborationSession,
      enabled: collaborationSessionEnabled,
      groupAgents,
    },
    inputRefs: {
      editor: editorRef,
      images: { current: images },
      files: { current: files },
      textContexts: { current: textContexts },
      diffTextContexts: { current: diffTextContexts },
      pastedTexts: { current: pastedTexts },
      fileContents: fileContentsRef,
      isStreaming: isStreamingRef,
    },
    actions: {
      scrollToBottom,
      onRestoreWorkspace,
      clearAll,
      clearTextContexts,
      clearDiffTextContexts,
      clearPastedTexts,
      clearFileContents,
      clearConversationDraft: (parentChatId: string, conversationId: string) => {
        clearConversationDraft(parentChatId, conversationId)
      },
    },
    queue: {
      addToQueue,
      popItemFromQueue,
      removeFromQueue,
    },
    messaging: {
      handleStop,
      sendMessageRef,
      setMessages,
      setExpiredQuestionsMap,
      setGroupAgentRuntimeStatuses,
      trackMessageSent,
      submitImplicitInteraction: (text: string) => {
        void trpcClient.ergatai.submitCollaborationInteraction
          .mutate({
            sessionId: collaborationSession.session?.id || conversationId,
            interaction: {
              type: "message_submitted",
              chatId: parentChatId,
              text,
              mentions: extractAgentMentions(text),
              workspaceId: workspaceId || undefined,
            },
            collaborationMode: isGroupMode ? "group" : "supervisor",
          })
          .catch((error) => {
            console.debug("[ImplicitCollaboration] Runtime unavailable:", error)
          })
      },
    },
    // Phase 18: Migrate to service-based queue system
    // Old logic commented out below, new logic uses chatInvocation.service
    service: chatInvocation.service,
  })

  // NOTE: Auto-processing of queue is now handled globally by QueueProcessor
  // component in agents-layout.tsx. This ensures queues continue processing
  // even when user navigates to different conversations or workspaces.

  // Helper to get message text content
  const getMessageTextContent = (msg: any): string => {
    return (
      msg.parts
        ?.filter((p: any) => p.type === "text")
        .map((p: any) => p.text)
        .join("\n") || ""
    )
  }

  // Helper to copy message content
  const copyMessageContent = (msg: any) => {
    const textContent = getMessageTextContent(msg)
    if (textContent) {
      navigator.clipboard.writeText(stripEmojis(textContent))
    }
  }

  // Unapproved plan detection - checks for ExitPlanMode and manages sidebar indicators
  const { hasUnapprovedPlan } = useUnapprovedPlanDetection({
    messages,
    conversationMode,
    conversationId,
    parentChatId,
    isActive,
    isStreaming,
    hasUnapprovedPlanRef,
    handleApprovePlan,
  })

  // Cmd/Ctrl + Arrow Down to scroll to bottom shortcut
  useScrollToBottomShortcut({
    isActive,
    scrollToBottom,
    editorRef,
  })

  // Get setter for pending plan approvals (for cleanup on unmount)
  const setPendingPlanApprovals = useSetAtom(pendingPlanApprovalsAtom)

  // Clean up pending plan approval when unmounting
  useEffect(() => {
    return () => {
      setPendingPlanApprovals((prev: Map<string, string>) => {
        if (prev.has(conversationId)) {
          const newMap = new Map(prev)
          newMap.delete(conversationId)
          return newMap
        }
        return prev
      })
    }
  }, [conversationId, setPendingPlanApprovals])

  // Compute sticky top class for user messages
  const stickyTopClass = isMobile
    ? CHAT_LAYOUT.stickyTopMobile
    : isConversationsSidebarOpen
      ? CHAT_LAYOUT.stickyTopSidebarOpen
      : CHAT_LAYOUT.stickyTopSidebarClosed

  // Sync messages to Jotai store and streaming status
  useMessageSync({
    conversationId,
    messages,
    status,
    isActive,
    isSplitPane,
  })

  // Chat search - scroll to current match
  useSearchScroll({ chatContainerRef })

  // Calculate top offset for search bar based on conversation selector
  const searchBarTopOffset = isConversationsSidebarOpen ? "52px" : undefined
  const shouldShowStatusCard =
    isStreaming || isCompacting || changedFilesForConversation.length > 0
  const shouldShowStackedCards =
    !displayQuestions && (queue.length > 0 || shouldShowStatusCard)
  const [hasPermissionApproval, setHasPermissionApproval] = useState(false)

  // Provider selection - handles switching between claude-code and codex providers
  const {
    handleInputProviderChange,
    handleContinueWithProvider,
    isContinuingRef,
  } = useProviderSelection({
    conversationId,
    parentChatId,
    conversationMode,
    isStreaming,
    messages,
    onProviderChange,
    utils,
    conversationNameRef,
  })

  return (
    <GroupChatProvider value={groupContextValue}>
      <SearchHighlightProvider>
      <div className="flex flex-col flex-1 min-h-0 relative">
        {/* Text selection popover for adding text to context - only render for active tab to avoid keep-alive portal collision */}
        {isActive && (
          <TextSelectionPopover
            onAddToContext={addTextContext}
            onQuickComment={handleQuickComment}
            onFocusInput={handleFocusInput}
          />
        )}

        {/* Quick comment input */}
        {quickCommentState && (
          <QuickCommentInput
            selectedText={quickCommentState.selectedText}
            source={quickCommentState.source}
            rect={quickCommentState.rect}
            onSubmit={handleQuickCommentSubmit}
            onCancel={handleQuickCommentCancel}
          />
        )}

        {/* Chat search bar */}
        <ChatSearchBar messages={messages} topOffset={searchBarTopOffset} />

        {/* Chat title - flex above scroll area (desktop only) */}
        {!isMobile && (
        <div
          className={cn(
            "flex-shrink-0 pb-2",
            isConversationsSidebarOpen ? "pt-[52px]" : "pt-2",
          )}
        >
          <ChatTitleEditor
            name={conversationName}
            placeholder="New Chat"
            onSave={handleRenameConversation}
            isMobile={false}
            entityId={conversationId}
            hasMessages={true} /* Always show "New Chat" placeholder when name is empty */
          />
          {/* Workspace subtitle: repo • branch */}
          {(workspaceRepoName || workspaceBranch) && (
            <div className="max-w-2xl mx-auto px-4">
              <span className="text-xs text-muted-foreground/50 truncate block">
                {[workspaceRepoName, workspaceBranch].filter(Boolean).join(" • ")}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Messages - shared with side chat; main owns scroll policy and main-only features */}
      <ChatMessagesRenderer
        messages={messages}
        status={status}
        conversationId={conversationId}
        chatId={parentChatId}
        isActive={isVisiblePane}
        isMobile={isMobile}
        sandboxSetupStatus={sandboxSetupStatus}
        sandboxSetupError={sandboxSetupError}
        onRetrySetup={onRetrySetup}
        stickyTopClass={stickyTopClass}
        emptyState={null}
        containerRef={(el) => {
          // Cleanup previous observer
          if (chatContainerObserverRef.current) {
            chatContainerObserverRef.current.disconnect()
            chatContainerObserverRef.current = null
          }

          chatContainerRef.current = el

          // Setup ResizeObserver for --chat-container-height/width CSS variables
          // Variables are set on both the element itself and the parent (relative wrapper)
          // so siblings like ScrollToBottomButton can also access them
          if (el) {
            const parent = el.parentElement
            const observer = new ResizeObserver((entries) => {
              const { height, width } = entries[0]?.contentRect ?? {
                height: 0,
                width: 0,
              }
              el.style.setProperty("--chat-container-height", `${height}px`)
              el.style.setProperty("--chat-container-width", `${width}px`)
              parent?.style.setProperty("--chat-container-height", `${height}px`)
              parent?.style.setProperty("--chat-container-width", `${width}px`)
            })
            observer.observe(el)
            chatContainerObserverRef.current = observer
          }
        }}
        contentWrapperRef={contentWrapperRef}
        className="flex-1 overflow-y-auto w-full relative allow-text-selection outline-none"
        contentClassName={cn("px-2 mx-auto -mb-4 max-w-2xl pb-8")}
        header={
          <>
            <ImplicitCollaborationTaskCards
              tasks={implicitCollaborationTasks}
            />
            <CollaborationSessionEventCards
              events={collaborationSession.events}
              session={collaborationSession.session}
            />
          </>
        }
        onRollback={handleRollback}
        onFork={handleForkFromMessage}
      />

      {isVisiblePane && (
        <div className="px-4 relative z-30">
          <div className="w-full px-2 max-w-2xl mx-auto">
            <PermissionApprovalPanel
              chatId={parentChatId}
              conversationId={conversationId}
              onHasPendingChange={setHasPermissionApproval}
            />
          </div>
        </div>
      )}

      {/* User questions panel - shows for both live (pending) and expired (timed out) questions */}
      {/* Hidden while a permission approval is pending to keep the dock uncluttered */}
      {!hasPermissionApproval && displayQuestions && (
        <div className="px-4 relative z-20">
          <div className="w-full px-2 max-w-2xl mx-auto">
            <AgentUserQuestion
              ref={questionRef}
              pendingQuestions={displayQuestions}
              onAnswer={handleQuestionsAnswer}
              onSkip={handleQuestionsSkip}
              hasCustomText={inputHasContent}
            />
          </div>
        </div>
      )}

      {/* Combined status container - queue + status card */}
      {/* Hidden while a permission approval is pending - the approval panel covers the dock */}
      {!hasPermissionApproval &&
        shouldShowStackedCards && (
        <div className="px-2 -mb-6 relative shadow-sm shadow-background">
          <div className="w-full max-w-2xl mx-auto px-2">
            {/* Queue indicator card */}
            {queue.length > 0 && (
              <AgentQueueIndicator
                queue={queue}
                onRemoveItem={handleRemoveFromQueue}
                onSendNow={handleSendFromQueue}
                hasStatusCardBelow={shouldShowStatusCard}
              />
            )}
            {/* Status card - bottom card */}
            {shouldShowStatusCard && (
              <ConversationStatusCard
                chatId={parentChatId}
                conversationId={conversationId}
                isStreaming={isStreaming}
                isCompacting={isCompacting}
                changedFiles={changedFilesForConversation}
                worktreePath={projectPath}
                onStop={handleStop}
                hasQueueCardAbove={queue.length > 0}
                hasAgentRailAbove={false}
              />
            )}
          </div>
        </div>
      )}

      {/* Input - isolated component to prevent re-renders */}
      <ChatInputArea
        editorRef={editorRef}
        fileInputRef={fileInputRef}
        onSend={handleSend}
        onForceSend={handleForceSend}
        onStop={handleStop}
        onCompact={handleCompact}
        onCreateNewConversation={onCreateNewConversation}
        onModeChange={handleModeChange}
        isStreaming={isStreaming}
        isCompacting={isCompacting}
        images={images}
        files={files}
        onAddAttachments={handleAddAttachments}
        onAddFolder={handleAddFolder}
        onRemoveImage={removeImage}
        onRemoveFile={removeFile}
        isUploading={isUploading}
        textContexts={textContexts}
        onRemoveTextContext={removeTextContext}
        diffTextContexts={diffTextContexts}
        onRemoveDiffTextContext={removeDiffTextContext}
        pastedTexts={pastedTexts}
        onAddPastedText={addPastedText}
        onRemovePastedText={removePastedText}
        onCacheFileContent={cacheFileContent}
        messageTokenData={messageTokenData}
        conversationId={conversationId}
        parentChatId={parentChatId}
        provider={provider}
        teamId={teamId}
        repository={repository}
        sandboxId={sandboxId}
        projectPath={projectPath}
        changedFiles={changedFilesForConversation}
        isMobile={isMobile}
        queueLength={queue.length}
        onSendFromQueue={handleSendFromQueue}
        firstQueueItemId={queue[0]?.id}
        onInputContentChange={setInputHasContent}
        onSubmitWithQuestionAnswer={submitWithQuestionAnswerCallback}
        onProviderChange={handleInputProviderChange}
        onContinueWithProvider={handleContinueWithProvider}
        isActive={isActive}
        isGroupMode={isGroupMode}
        onGroupAgentsChange={isGroupMode ? handleGroupAgentsChange : undefined}
      />

        {/* Scroll to bottom button - isolated component to avoid re-renders during streaming */}
        <ScrollToBottomButton
          containerRef={chatContainerRef}
          onScrollToBottom={scrollToBottom}
          hasStackedCards={shouldShowStackedCards}
          conversationId={conversationId}
          isActive={isActive}
          isSplitPane={isSplitPane}
        />
      </div>
      </SearchHighlightProvider>
    </GroupChatProvider>
  )
})

// Chat View wrapper - handles loading and creates chat object
export function ChatView({
  chatId,
  isSidebarOpen,
  onToggleSidebar,
  selectedTeamName,
  selectedTeamImageUrl,
  isMobileFullscreen = false,
  onBackToChats,
  onOpenPreview,
  onOpenDiff,
  onOpenTerminal,
  hideHeader = false,
}: {
  chatId: string
  isSidebarOpen: boolean
  onToggleSidebar: () => void
  selectedTeamName?: string
  selectedTeamImageUrl?: string
  isMobileFullscreen?: boolean
  onBackToChats?: () => void
  onOpenPreview?: () => void
  onOpenDiff?: () => void
  onOpenTerminal?: () => void
  hideHeader?: boolean
}) {
  const [selectedTeamId] = useAtom(selectedTeamIdAtom)

  // Get active conversation ID from store for mode tracking (reactive)
  const activeConversationIdForMode = useAgentConversationStore((state) => state.activeConversationId)
  // Use per-conversation? mode atom - falls back to "agent" if no active conversation
  const conversationModeAtom = useMemo(
    () => conversationModeAtomFamily(activeConversationIdForMode || ""),
    [activeConversationIdForMode],
  )
  const [conversationMode] = useAtom(conversationModeAtom)
  // Default mode for new conversations (used as fallback when no active conversation)
  const defaultAgentMode = useAtomValue(defaultAgentModeAtom)
  // Current mode - use conversationMode when there's an active conversation, otherwise use user's default preference
  const currentMode: AgentMode = activeConversationIdForMode ? conversationMode : defaultAgentMode

  const isDesktop = useAtomValue(isDesktopAtom)
  const isFullscreen = useAtomValue(isFullscreenAtom)
  const sidebarOpen = useAtomValue(agentsSidebarOpenAtom)
  const customClaudeConfig = useAtomValue(customClaudeConfigAtom)
  const selectedOllamaModel = useAtomValue(selectedOllamaModelAtom)
  const normalizedCustomClaudeConfig =
    normalizeCustomClaudeConfig(customClaudeConfig)
  const hasCustomClaudeConfig = Boolean(normalizedCustomClaudeConfig)
  const setLoadingConversations = useSetAtom(loadingConversationsAtom)
  const unseenChanges = useAtomValue(agentsUnseenChangesAtom)
  const setUnseenChanges = useSetAtom(agentsUnseenChangesAtom)
  const setConversationUnseenChanges = useSetAtom(agentsConversationUnseenChangesAtom)
  const setJustCreatedIds = useSetAtom(justCreatedIdsAtom)
  const selectedChatId = useAtomValue(selectedAgentChatIdAtom)
  const setUndoStack = useSetAtom(undoStackAtom)
  const setSelectedFilePath = useSetAtom(selectedDiffFilePathAtom)
  const setFilteredDiffFiles = useSetAtom(filteredDiffFilesAtom)
  const { notifyAgentComplete } = useDesktopNotifications()

  // Check if any chat has unseen changes
  const hasAnyUnseenChanges = unseenChanges.size > 0
  const [, forceUpdate] = useState({})

  // Extract sidebar states into a hook
  const sidebarStates = useSidebarStates(chatId)
  const {
    isPreviewSidebarOpen,
    setIsPreviewSidebarOpen,
    isDiffSidebarOpen,
    setIsDiffSidebarOpen,
    selectedFilePath,
    isPlanSidebarOpen,
    setIsPlanSidebarOpen,
    currentPlanPath,
    setCurrentPlanPath,
    handleApprovePlanFromSidebar,
    fileViewerPath,
    setFileViewerPath,
    fileViewerDisplayMode,
    fileSearchOpen,
    setFileSearchOpen,
    isUnifiedSidebarEnabled,
    isDetailsSidebarOpen,
    setIsDetailsSidebarOpen,
    detailsSidebarTab,
    setDetailsSidebarTab,
    handleToggleDetailsSidebarTab,
    toggleDetailsHotkey,
    isSideChatSidebarOpen,
    setIsSideChatSidebarOpen,
    isTerminalSidebarOpen,
    setIsTerminalSidebarOpen,
    terminalDisplayMode,
    toggleTerminalHotkey,
  } = sidebarStates

  // Mutual exclusion: Details sidebar vs Plan/Terminal/Diff(side-peek) sidebars
  // When one opens, close the conflicting ones and remember for restoration

  // Sidebar mutual exclusion - manages conflicts between Details/SideChat and Plan/Terminal
  const { autoClosedStateRef } = useSidebarMutex({
    isDetailsSidebarOpen,
    isSideChatSidebarOpen,
    isPlanSidebarOpen,
    currentPlanPath,
    isTerminalSidebarOpen,
    terminalDisplayMode,
    setIsDetailsSidebarOpen,
    setIsSideChatSidebarOpen,
    setIsPlanSidebarOpen,
    setIsTerminalSidebarOpen,
  })

  // Diff data cache - stored in atoms to persist across workspace switches
  const diffCacheAtom = useMemo(
    () => workspaceDiffCacheAtomFamily(chatId),
    [chatId],
  )
  const [diffCache, setDiffCache] = useAtom(diffCacheAtom)

  // Extract diff data from cache
  const diffStats = diffCache.diffStats
  const parsedFileDiffs = diffCache.parsedFileDiffs as ParsedDiffFile[] | null
  const prefetchedFileContents = diffCache.prefetchedFileContents
  const diffContent = diffCache.diffContent

  // Smart setters for diff cache - prevent unnecessary re-renders
  const { setDiffStats, setParsedFileDiffs, setPrefetchedFileContents, setDiffContent } = useDiffCache({ setDiffCache })
  const [diffMode, setDiffMode] = useAtom(diffViewModeAtom)
  const [diffDisplayMode, setDiffDisplayMode] = useAtom(diffViewDisplayModeAtom)
  const conversationsSidebarMode = useAtomValue(agentsConversationsSidebarModeAtom)


  // Force narrow width when switching to side-peek mode (from dialog/fullscreen)
  useEffect(() => {
    if (diffDisplayMode === "side-peek") {
      // Set to narrow width (400px) to ensure correct layout
      appStore.set(agentsDiffSidebarWidthAtom, 400)
    }
  }, [diffDisplayMode])

  // Diff sidebar conflicts - manages conflicts between Diff (side-peek) and Details/SideChat
  useDiffSidebarConflicts({
    isDiffSidebarOpen,
    diffDisplayMode,
    isDetailsSidebarOpen,
    isSideChatSidebarOpen,
    setIsDiffSidebarOpen,
    setIsDetailsSidebarOpen,
    setIsSideChatSidebarOpen,
    autoClosedStateRef,
  })

  // Hide/show traffic lights based on full-page diff or full-page file viewer
  // When exiting full-page mode, restore based on sidebar state (not unconditionally true)
  useEffect(() => {
    if (!isDesktop || isFullscreen) return
    if (typeof window === "undefined" || !window.desktopApi?.setTrafficLightVisibility) return

    const isFullPageDiff = isDiffSidebarOpen && diffDisplayMode === "full-page"
    const isFullPageFileViewer = !!fileViewerPath && fileViewerDisplayMode === "full-page"
    const shouldHide = isFullPageDiff || isFullPageFileViewer
    window.desktopApi.setTrafficLightVisibility(shouldHide ? false : sidebarOpen)
  }, [isDiffSidebarOpen, diffDisplayMode, fileViewerPath, fileViewerDisplayMode, isDesktop, isFullscreen, sidebarOpen])

  // Track diff sidebar width for responsive header
  const storedDiffSidebarWidth = useAtomValue(agentsDiffSidebarWidthAtom)
  const diffSidebarRef = useRef<HTMLDivElement>(null)
  const diffViewRef = useRef<AgentDiffViewRef>(null)

  // Diff sidebar width tracking with ResizeObserver
  const { diffSidebarWidth, setDiffSidebarWidth } = useDiffSidebarWidth({
    isDiffSidebarOpen,
    storedDiffSidebarWidth,
    diffSidebarRef,
  })

  // Track if all diff files are collapsed/expanded for button disabled states
  const [diffCollapseState, setDiffCollapseState] = useState({
    allCollapsed: false,
    allExpanded: true,
  })

  // Compute isNarrow for filtering logic (same threshold as DiffSidebarContent)
  const isDiffSidebarNarrow = diffSidebarWidth < 500

  // Track changed files across all conversations for filtering
  const conversationFiles = useAtomValue(conversationFilesAtom)

  // Clear "unseen changes" when chat is opened
  useEffect(() => {
    setUnseenChanges((prev: Set<string>) => {
      if (prev.has(chatId)) {
        const next = new Set(prev)
        next.delete(chatId)
        return next
      }
      return prev
    })
  }, [chatId, setUnseenChanges])

  // Get conversation state from store (reactive subscription for tabsToRender)
  const {
    activeConversationId,
    openConversationIds,
    pinnedConversationIds,
    allConversations,
    splitPaneIds,
  } = useAgentConversationStore(
    useShallow((state) => ({
      activeConversationId: state.activeConversationId,
      openConversationIds: state.openConversationIds,
      pinnedConversationIds: state.pinnedConversationIds,
      allConversations: state.allConversations,
      splitPaneIds: state.splitPaneIds,
    }))
  )
  const [
    conversationProviderOverrides,
    setConversationProviderOverrides,
  ] = useState<Record<string, "claude-code" | "codex">>({})

  useEffect(() => {
    setConversationProviderOverrides({})
  }, [chatId])

  // Clear conversation "unseen changes" indicator when conversation becomes active
  useEffect(() => {
    if (!activeConversationId) return
    setConversationUnseenChanges((prev: Set<string>) => {
      if (prev.has(activeConversationId)) {
        const next = new Set(prev)
        next.delete(activeConversationId)
        return next
      }
      return prev
    })
  }, [activeConversationId, setConversationUnseenChanges])

  // tRPC utils for optimistic cache updates
  const utils = api.useUtils()

  // tRPC mutations for renaming
  const renameConversationMutation = api.agents.renameConversation.useMutation()

  // PR creation loading state - using atom to allow ChatViewInner to reset it
  const [isCreatingPr, setIsCreatingPr] = useAtom(isCreatingPrAtom)
  // Review loading state
  const [isReviewing, setIsReviewing] = useState(false)
  // Conversation filter setter - used by handleReview to filter by active conversation
  const setFilteredConversationId = useSetAtom(filteredConversationIdAtom)
  const setSessionInfo = useSetAtom(sessionInfoAtom)

  // Fetch chat data from local or remote based on mode
  // Only fetch if chatId looks like a valid chat ID (starts with "chat_")
  const isValidChatId = chatId?.startsWith("chat_")
  const { data: localAgentChat, isLoading: isLocalLoading } = api.agents.getAgentChat.useQuery(
    { chatId },
    { enabled: !!isValidChatId },
  )

  const agentChat = localAgentChat
  const isLoading = isLocalLoading

  // Compute if we're waiting for local chat data (used as loading gate)
  const isLocalChatLoading = isLocalLoading

  const agentConversations = (agentChat?.conversations ?? []) as Array<{
    id: string
    name?: string | null
    mode?: "plan" | "agent" | null
    created_at?: Date | string | null
    updated_at?: Date | string | null
    messages?: any
  }>

  // Workspace isolation: limit mounted tabs to prevent memory growth
  // Tabs to render - handles filtering and validation of conversation tabs
  const { tabsToRender } = useTabsToRender({
    activeConversationId,
    splitPaneIds,
    pinnedConversationIds,
    openConversationIds,
    allConversations,
    agentConversations,
  })

  // Prune chat instances from previous workspace when switching parent chat.
  // Prevents cross-workspace memory accumulation.
  const previousParentChatIdRef = useRef<string | null>(chatId)
  useEffect(() => {
    const previousParentChatId = previousParentChatIdRef.current
    if (previousParentChatId && previousParentChatId !== chatId) {
      for (const conversationId of agentChatStore.keys()) {
        if (agentChatStore.getParentChatId(conversationId) !== previousParentChatId) continue
        if (useStreamingStatusStore.getState().isStreaming(conversationId)) continue
        if ((useMessageQueueStore.getState().queues[conversationId]?.length ?? 0) > 0) continue
        agentChatStore.delete(conversationId)
        clearRuntimeCachesForConversation(conversationId)
      }
    }
    previousParentChatIdRef.current = chatId
  }, [chatId])

  // Bound resident chat instances in memory for current workspace.
  // Keep mounted tabs and currently streaming chats; evict everything else.
  useEffect(() => {
    if (!activeConversationId) return
    if (tabsToRender.length === 0) return

    const keep = new Set(tabsToRender)
    keep.add(activeConversationId)
    for (const conversationId of agentChatStore.keys()) {
      if (agentChatStore.getParentChatId(conversationId) !== chatId) continue
      if (keep.has(conversationId)) continue
      if (useStreamingStatusStore.getState().isStreaming(conversationId)) continue
      if ((useMessageQueueStore.getState().queues[conversationId]?.length ?? 0) > 0) continue

      agentChatStore.delete(conversationId)
      clearRuntimeCachesForConversation(conversationId)
    }
  }, [activeConversationId, chatId, tabsToRender])

  // Get PR status when PR exists (for checking if it's open/merged/closed)
  const hasPrNumber = !!agentChat?.prNumber
  const { data: prStatusData, isLoading: isPrStatusLoading } = trpc.chats.getPrStatus.useQuery(
    { chatId },
    {
      enabled: hasPrNumber,
      refetchInterval: 30000, // Poll every 30 seconds
    }
  )
  const prState = prStatusData?.pr?.state as "open" | "draft" | "merged" | "closed" | undefined
  const prMergeable = prStatusData?.pr?.mergeable
  const hasMergeConflicts = prMergeable === "CONFLICTING"
  // PR is open if state is explicitly "open" or "draft"
  // When PR status is still loading, assume open to avoid showing wrong button
  const isPrOpen = hasPrNumber && (isPrStatusLoading || prState === "open" || prState === "draft")

  // Merge PR mutation
  const trpcUtils = trpc.useUtils()

  // Direct PR creation mutation (push branch and open GitHub)
  const createPrMutation = trpc.changes.createPR.useMutation({
    onSuccess: () => {
      toast.success("Opening GitHub to create PR...", { position: "top-center" })
      refetchGitStatus()
    },
    onError: (error) => {
      toast.error(error.message || "Failed to create PR", { position: "top-center" })
    },
  })

  // Sync from main mutation (for resolving merge conflicts)
  const mergeFromDefaultMutation = trpc.changes.mergeFromDefault.useMutation({
    onSuccess: () => {
      toast.success("Branch synced with main. You can now merge the PR.", { position: "top-center" })
      // Invalidate PR status to refresh mergeability
      trpcUtils.chats.getPrStatus.invalidate({ chatId })
    },
    onError: (error) => {
      toast.error(error.message || "Failed to sync with main", { position: "top-center" })
    },
  })

  const mergePrMutation = trpc.chats.mergePr.useMutation({
    onSuccess: () => {
      toast.success("PR merged successfully!", { position: "top-center" })
      // Invalidate PR status to update button state
      trpcUtils.chats.getPrStatus.invalidate({ chatId })
    },
    onError: (error) => {
      const errorMsg = error.message || "Failed to merge PR"

      // Check if it's a merge conflict error
      if (errorMsg.includes("MERGE_CONFLICT")) {
        toast.error(
          "PR has merge conflicts. Sync with main to resolve.",
          {
            position: "top-center",
            duration: 8000,
            action: worktreePath ? {
              label: "Sync with Main",
              onClick: () => {
                mergeFromDefaultMutation.mutate({ worktreePath, useRebase: false })
              },
            } : undefined,
          }
        )
      } else {
        toast.error(errorMsg, { position: "top-center" })
      }
    },
  })

  const handleMergePr = useCallback(() => {
    mergePrMutation.mutate({ chatId, method: "squash" })
  }, [chatId, mergePrMutation])

  // Restore archived workspace mutation (silent - no toast) - use unarchiveChat for chat container
  const restoreWorkspaceMutation = trpc.ergatai.unarchiveChat.useMutation({
    onSuccess: () => {
      trpcUtils.chats.list.invalidate()
      trpcUtils.ergatai.listManagedWorkspaces.invalidate()
      void trpcUtils.ergatai.workspaceStatus.invalidate()
      trpcUtils.chats.listArchived.invalidate()
      // Invalidate this chat's data to update isArchived state
      utils.agents.getAgentChat.invalidate({ chatId })
    },
  })

  const handleRestoreWorkspace = useCallback(() => {
    restoreWorkspaceMutation.mutate({ id: chatId })
  }, [chatId, restoreWorkspaceMutation])

  // Check if this workspace is archived
  const isArchived = !!agentChat?.archivedAt
  const isGroupMode = (agentChat as any)?.collaborationMode === "group"

  // Get user usage data for credit checks
  const { data: usageData } = api.usage.getUserUsage.useQuery()

  // Desktop: use worktreePath instead of sandbox
  const worktreePath = agentChat?.worktreePath as string | null
  const panelLinkScopeKey = createPanelLinkScopeKey({ chatId })
  const dispatchPanelLink = useSetAtom(
    panelLinkCommandAtomFamily(panelLinkScopeKey),
  )
  const setLinkedFileViewerPath = useCallback(
    (filePath: string | null) => {
      dispatchPanelLink({
        type: "sync-panel",
        panelId: "file-viewer",
        open: !!filePath,
        target: filePath
          ? {
              kind: "file",
              id: filePath,
              path: filePath,
              chatId,
              workspaceId: worktreePath ?? undefined,
            }
          : null,
        source: "user",
      })
      setFileViewerPath(filePath)
    },
    [chatId, setFileViewerPath, worktreePath],
  )
  // Desktop: original project path for MCP config lookup
  const originalProjectPath = (agentChat as any)?.project?.path as string | undefined

  // Terminal scope key: shared by project path (local mode) or isolated per workspace (worktree)
  const terminalScopeKey = useMemo(() => {
    return getTerminalScopeKey({
      branch: (agentChat as any)?.branch ?? null,
      worktreePath: worktreePath,
      id: chatId,
    })
  }, [(agentChat as any)?.branch, worktreePath, chatId])
  // Fallback for web: use sandbox_id
  const sandboxId: string | null = null
  const sandboxUrl = null
  // Desktop uses worktreePath, web uses sandboxUrl
  const chatWorkingDir = worktreePath || sandboxUrl

  // Plugin MCP approval - disabled for now since official marketplace plugins
  // are trusted by default. Will re-enable when third-party plugin support is added.

  // Extract port, repository, and quick setup flag from meta
  const meta = agentChat?.meta as {
    sandboxConfig?: { port?: number }
    repository?: string
    branch?: string | null
    isQuickSetup?: boolean
  } | null
  const repository = meta?.repository

  // Remote info for Details sidebar (when worktreePath is null but sandboxId exists)
  const remoteInfo = null

  // Track if we've already triggered sandbox setup for this chat
  // Check if this is a quick setup (no preview available)
  const isQuickSetup = meta?.isQuickSetup || !meta?.sandboxConfig?.port
  const previewPort = meta?.sandboxConfig?.port ?? 3000

  // Check if preview can be opened (sandbox with port exists and not quick setup)
  const canOpenPreview = !!(
    sandboxId &&
    !isQuickSetup &&
    meta?.sandboxConfig?.port
  )

  // Check if diff button can be shown (stats available)
  // This shows the Changes button with stats in header
  const canShowDiffButton = !!worktreePath

  // Check if diff sidebar can be opened (actual diff content available)
  // Desktop remote chats (sandboxId without worktree) cannot open diff sidebar - only stats in header
  const canOpenDiff = !!worktreePath

  // Create list of conversations with changed files for filtering
  // Only include conversations that have uncommitted changes, sorted by most recent first
  const conversationsWithFiles = useMemo(() => {
    const result: Array<{
      id: string
      name: string
      filePaths: string[]
      fileCount: number
      updatedAt: string
    }> = []

    // Only include conversations that have files (uncommitted changes)
    for (const conversation of allConversations) {
      const files = conversationFiles.get(conversation.id) || []
      if (files.length > 0) {
        result.push({
          id: conversation.id,
          name: conversation.name || "New Chat",
          filePaths: files.map((f) => f.filePath),
          fileCount: files.length,
          updatedAt: conversation.updated_at || conversation.created_at || "",
        })
      }
    }

    // Sort by most recent first
    result.sort((a, b) => {
      if (!a.updatedAt && !b.updatedAt) return 0
      if (!a.updatedAt) return 1
      if (!b.updatedAt) return -1
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    })

    return result
  }, [allConversations, conversationFiles])

  // Close preview sidebar if preview becomes unavailable
  useEffect(() => {
    if (!canOpenPreview && isPreviewSidebarOpen) {
      setIsPreviewSidebarOpen(false)
    }
  }, [canOpenPreview, isPreviewSidebarOpen, setIsPreviewSidebarOpen])

  // Note: We no longer forcibly close diff sidebar when canOpenDiff is false.
  // The sidebar render is guarded by canOpenDiff, so it naturally hides.
  // Per-chat state (diffSidebarOpenAtomFamily) preserves each chat's preference.

  // Diff stats management - handles fetching, debouncing, and throttling
  const {
    fetchDiffStats,
    fetchDiffStatsDebounced,
    fetchDiffStatsRef,
    scheduleDiffRefresh,
  } = useDiffStatsManagement({
    worktreePath,
    chatId,
    isDiffSidebarOpen,
    setParsedFileDiffs,
    setPrefetchedFileContents,
    setDiffContent,
    setDiffStats,
  })

  // Listen for file changes from Claude Write/Edit tools and refresh diff
  useFileChangeListener(worktreePath, { onChange: scheduleDiffRefresh })

  // Subscribe to GitWatcher for real-time file system monitoring (chokidar on main process)
  useGitWatcher(worktreePath, { onChange: scheduleDiffRefresh, debounceMs: 200 })

  // Git operations - PR creation, commit, review, conflict resolution
  const {
    handleCreatePrDirect,
    handleCreatePr,
    handleCommitToPr,
    handleReview,
    handleFixConflicts,
    isCommittingToPr,
  } = useGitOperations({
    worktreePath,
    chatId,
    activeConversationId,
    setIsCreatingPr,
    setIsReviewing,
    setFilteredConversationId,
    createPrMutation,
  })

  // Fetch branch data for diff sidebar header
  const { data: branchData } = trpc.changes.getBranches.useQuery(
    { worktreePath: worktreePath || "" },
    { enabled: !!worktreePath }
  )

  // Fetch git status for sync counts (pushCount, pullCount, hasUpstream)
  const { data: gitStatus, refetch: refetchGitStatus, isLoading: isGitStatusLoading } = trpc.changes.getStatus.useQuery(
    { worktreePath: worktreePath || "" },
    { enabled: !!worktreePath && (isDiffSidebarOpen || isDetailsSidebarOpen), staleTime: 30000 }
  )

  const handleCommitChangesRefresh = useCallback(() => {
    refetchGitStatus()
    scheduleDiffRefresh()
  }, [refetchGitStatus, scheduleDiffRefresh])

  const {
    commit: commitChanges,
    isPending: isCommittingChanges,
  } = useCommitActions({
    worktreePath,
    chatId,
    onRefresh: handleCommitChangesRefresh,
  })

  const { push: pushBranch, isPending: isPushing } = usePushAction({
    worktreePath,
    hasUpstream: gitStatus?.hasUpstream ?? true,
    onSuccess: handleCommitChangesRefresh,
  })

  const handleCommitChanges = useCallback((selectedPaths: string[]) => {
    commitChanges({ filePaths: selectedPaths })
  }, [commitChanges])

  const handleCommitAndPush = useCallback(async (selectedPaths: string[]) => {
    const didCommit = await commitChanges({ filePaths: selectedPaths })
    if (didCommit) {
      pushBranch()
    }
  }, [commitChanges, pushBranch])

  const isCommittingCombined = isCommittingChanges || isPushing

  // Refetch git status and diff stats when window gains focus
  useEffect(() => {
    if (!worktreePath || !isDiffSidebarOpen) return

    const handleWindowFocus = () => {
      // Refetch git status
      refetchGitStatus()
      // Refetch diff stats to get latest changes
      fetchDiffStats()
    }

    window.addEventListener('focus', handleWindowFocus)
    return () => window.removeEventListener('focus', handleWindowFocus)
  }, [worktreePath, isDiffSidebarOpen, refetchGitStatus, fetchDiffStats])

  // Sync parsedFileDiffs with git status - clear diff data when all files are committed
  useGitStatusSync({
    gitStatus,
    isGitStatusLoading,
    parsedFileDiffs,
    setParsedFileDiffs,
    setPrefetchedFileContents,
    setDiffContent,
    setDiffStats,
  })

  // Stable callbacks for DiffSidebarHeader to prevent re-renders
  const handleRefreshGitStatus = useCallback(() => {
    refetchGitStatus()
    scheduleDiffRefresh()
  }, [refetchGitStatus, scheduleDiffRefresh])

  const handleExpandAll = useCallback(() => {
    diffViewRef.current?.expandAll()
  }, [])

  const handleCollapseAll = useCallback(() => {
    diffViewRef.current?.collapseAll()
  }, [])

  const handleMarkAllViewed = useCallback(() => {
    diffViewRef.current?.markAllViewed()
  }, [])

  const handleMarkAllUnviewed = useCallback(() => {
    diffViewRef.current?.markAllUnviewed()
  }, [])

  // Initialize conversation store from DB data
  useConversationStoreInit({
    agentChat,
    chatId,
  })

  const inferProviderFromMessages = useCallback(
    (conversationId?: string): "claude-code" | "codex" => {
      if (!conversationId) return "claude-code"

      const override = conversationProviderOverrides[conversationId]
      if (override) return override

      const conversation = ((agentChat as any)?.conversations || []).find(
        (sc: any) => sc?.id === conversationId,
      ) as { messages?: any } | undefined
      const rawMessages = conversation?. messages

      let messages: any[] = []
      if (Array.isArray(rawMessages)) {
        messages = rawMessages
      } else if (typeof rawMessages === "string") {
        try {
          const parsed = JSON.parse(rawMessages)
          messages = Array.isArray(parsed) ? parsed : []
        } catch {
          messages = []
        }
      }

      for (const message of messages) {
        const model = (message as any)?.metadata?.model
        if (typeof model !== "string") continue
        const normalizedModel = model.toLowerCase()
        if (
          normalizedModel.includes("codex") ||
          normalizedModel.startsWith("gpt-")
        ) {
          return "codex"
        }
      }

      return "claude-code"
    },
    [agentChat, conversationProviderOverrides],
  )

  const activeConversationProvider = useMemo(
    () => inferProviderFromMessages(activeConversationId || undefined),
    [activeConversationId, inferProviderFromMessages],
  )

  // Chat instance factory - creates Chat instances with proper transport and lifecycle
  const { getOrCreateChat, syncFinishedMessagesToChatCache, pruneIfDetachedAndIdle } = useChatInstanceFactory({
    chat: {
      agentChat,
      chatWorkingDir,
      worktreePath,
      chatId,
      currentMode,
    },
    provider: {
      inferProviderFromMessages,
      conversationProviderOverrides,
    },
    state: {
      setConversationUnseenChanges,
      setUnseenChanges,
      setLoadingConversations,
      selectedChatId,
      agentConversations,
      isGroupMode,
    },
    utils: {
      utils,
      trpcUtils,
      fetchDiffStatsRef,
      forceUpdate,
    },
  })

  const handleProviderChange = useCallback(
    (conversationId: string, nextProvider: "claude-code" | "codex") => {
      // Provider switch is only allowed for brand new conversations.
      const activeChat = agentChatStore.get(conversationId) as any
      let messageCount = Array.isArray(activeChat?.messages)
        ? activeChat.messages.length
        : 0

      if (messageCount === 0) {
        const conversation = agentConversations.find((sc) => sc.id === conversationId)
        const rawMessages = conversation?. messages
        if (Array.isArray(rawMessages)) {
          messageCount = rawMessages.length
        } else if (typeof rawMessages === "string") {
          try {
            const parsed = JSON.parse(rawMessages)
            messageCount = Array.isArray(parsed) ? parsed.length : 0
          } catch {
            messageCount = 0
          }
        }
      }

      if (messageCount > 0) return

      setConversationProviderOverrides((prev) => ({
        ...prev,
        [conversationId]: nextProvider,
      }))

      // Force transport recreation with the newly selected provider.
      agentChatStore.delete(conversationId)
      forceUpdate({})
    },
    [agentConversations],
  )

  // Create new conversation - handles creating a new conversation with all setup
  const { handleCreateNewConversation } = useCreateNewConversation({
    worktreePath,
    chatId,
    defaultAgentMode,
    activeConversationId,
    inferProviderFromMessages,
    utils,
    setConversationUnseenChanges,
    selectedChatId,
    setUnseenChanges,
    notifyAgentComplete,
    syncFinishedMessagesToChatCache,
    pruneIfDetachedAndIdle,
    agentChat: agentChat ? { name: agentChat.name ?? undefined } : undefined,
    isGroupMode,
    setJustCreatedIds,
    setConversationProviderOverrides,
    agentChatStore,
    forceUpdate,
    setLoadingConversations,
    fetchDiffStatsRef,
  })

  // Keyboard shortcut: New conversation
  // Web: Opt+Cmd+T (browser uses Cmd+T for new tab)
  // Desktop: Cmd+T
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isDesktop = isDesktopApp()

      // Desktop: Cmd+T (without Alt)
      if (isDesktop && e.metaKey && e.code === "KeyT" && !e.altKey) {
        e.preventDefault()
        handleCreateNewConversation()
        return
      }

      // Web: Opt+Cmd+T (with Alt)
      if (e.altKey && e.metaKey && e.code === "KeyT") {
        e.preventDefault()
        handleCreateNewConversation()
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [handleCreateNewConversation])

  // NOTE: Desktop notifications for pending questions are now triggered directly
  // in ergatai-chat-transport.ts when the tool_call_start chunk arrives.
  // This prevents duplicate notifications from multiple ChatView instances.

  // Multi-select state for conversations (for Cmd+W bulk close)
  const selectedConversationIds = useAtomValue(selectedConversationIdsAtom)
  const isConversationMultiSelectMode = useAtomValue(isConversationMultiSelectModeAtom)
  const clearConversationSelection = useSetAtom(clearConversationSelectionAtom)

  // Conversation keyboard shortcuts - close tabs and navigate between them
  useConversationShortcuts({
    chatId,
    setUndoStack,
    selectedConversationIds,
    isConversationMultiSelectMode,
    clearConversationSelection,
  })

  // Keyboard shortcut: Cmd + D to toggle diff sidebar
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Check for Cmd (Meta) + D (without Alt/Shift)
      if (
        e.metaKey &&
        !e.altKey &&
        !e.shiftKey &&
        !e.ctrlKey &&
        e.code === "KeyD"
      ) {
        e.preventDefault()
        e.stopPropagation()

        // Toggle diff sidebar
        setIsDiffSidebarOpen(!isDiffSidebarOpen)
      }
    }

    window.addEventListener("keydown", handleKeyDown, true)
    return () => window.removeEventListener("keydown", handleKeyDown, true)
  }, [isDiffSidebarOpen])


  // Keyboard shortcut: Cmd + Shift + E to restore archived workspace
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.metaKey &&
        e.shiftKey &&
        !e.altKey &&
        !e.ctrlKey &&
        e.code === "KeyE"
      ) {
        if (isArchived && !restoreWorkspaceMutation.isPending) {
          e.preventDefault()
          e.stopPropagation()
          handleRestoreWorkspace()
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown, true)
    return () => window.removeEventListener("keydown", handleKeyDown, true)
  }, [isArchived, restoreWorkspaceMutation.isPending, handleRestoreWorkspace])

  // Get or create Chat instance for active conversation
  const activeChat = useMemo(() => {
    if (!activeConversationId || !agentChat) {
      return null
    }
    return getOrCreateChat(activeConversationId)
  }, [activeConversationId, agentChat, getOrCreateChat, chatId, chatWorkingDir])

  // Check if active conversation is the first one (for renaming parent chat)
  // Use agentConversations directly to avoid race condition with store initialization
  const isFirstConversationActive = useMemo(() => {
    if (!activeConversationId) return false
    return getFirstConversationId(agentConversations) === activeConversationId
  }, [activeConversationId, agentConversations])

  // Determine if chat header should be hidden
  const shouldHideChatHeader =
    hideHeader ||
    (conversationsSidebarMode === "sidebar" &&
    isPreviewSidebarOpen &&
    isDiffSidebarOpen &&
    !isMobileFullscreen)

  // No early return - let the UI render with loading state handled by activeChat check below

  return (
    <FileOpenProvider onOpenFile={setLinkedFileViewerPath}>
    <TextSelectionProvider>
    {/* File Search Dialog (Cmd+P) */}
    {worktreePath && (
      <FileSearchDialog
        open={fileSearchOpen}
        onOpenChange={setFileSearchOpen}
        projectPath={worktreePath}
        onSelectFile={setLinkedFileViewerPath}
      />
    )}
    <div className="flex h-full flex-col">
      {/* Main content */}
      <div className="flex-1 overflow-hidden flex">
        {/* Chat Panel */}
        <div
          className="flex-1 flex flex-col overflow-hidden relative"
          style={{ minWidth: "350px" }}
        >
          {/* ConversationSelector header - absolute when sidebar open (desktop only), regular div otherwise */}
          {!shouldHideChatHeader && (
            <div
              className={cn(
                "relative z-20 pointer-events-none",
                // Mobile: always flex; Desktop: absolute when sidebar open, flex when closed
                !isMobileFullscreen && conversationsSidebarMode === "sidebar"
                  ? `absolute top-0 left-0 right-0 ${CHAT_LAYOUT.headerPaddingSidebarOpen}`
                  : `flex-shrink-0 ${CHAT_LAYOUT.headerPaddingSidebarClosed}`,
              )}
            >
              {/* Gradient background - only when not absolute */}
              {(isMobileFullscreen || conversationsSidebarMode !== "sidebar") && (
                <div className="absolute inset-0 bg-gradient-to-b from-background via-background to-transparent" />
              )}
              <div className="pointer-events-auto flex items-center justify-between relative">
                <div className="flex-1 min-w-0 flex items-center gap-2">
                  {/* Mobile header - simplified with chat name as trigger */}
                  {isMobileFullscreen ? (
                    <MobileChatHeader
                      onCreateNew={handleCreateNewConversation}
                      onBackToChats={onBackToChats}
                      onOpenPreview={onOpenPreview}
                      canOpenPreview={canOpenPreview}
                      onOpenDiff={onOpenDiff}
                      canOpenDiff={canShowDiffButton}
                      diffStats={diffStats}
                      onOpenTerminal={onOpenTerminal}
                      canOpenTerminal={!!worktreePath}
                      isTerminalOpen={isTerminalSidebarOpen}
                      isArchived={isArchived}
                      onRestore={handleRestoreWorkspace}
                    />
                  ) : (
                    <>
                      {/* Header controls - desktop only */}
                      <AgentsHeaderControls
                        isSidebarOpen={isSidebarOpen}
                        onToggleSidebar={onToggleSidebar}
                        hasUnseenChanges={hasAnyUnseenChanges}
                        isConversationsSidebarOpen={
                          conversationsSidebarMode === "sidebar"
                        }
                      />
                      <ConversationSelector
                        onCreateNew={handleCreateNewConversation}
                        isMobile={false}
                        onBackToChats={onBackToChats}
                        onOpenPreview={onOpenPreview}
                        canOpenPreview={canOpenPreview}
                        onOpenDiff={
                          canOpenDiff
                            ? () => {
                                if (isUnifiedSidebarEnabled) {
                                  // Unified sidebar: open the Git page
                                  handleToggleDetailsSidebarTab("git")
                                } else {
                                  setIsDiffSidebarOpen(true)
                                }
                              }
                            : undefined
                        }
                        canOpenDiff={canShowDiffButton}
                        onOpenTerminal={() => setIsTerminalSidebarOpen(true)}
                        canOpenTerminal={!!worktreePath}
                        isTerminalOpen={isTerminalSidebarOpen}
                        chatId={chatId}
                      />
                    </>
                  )}
                </div>
                {/* Open Preview Button - shows when preview is closed (desktop only, local mode only) */}
                {!isMobileFullscreen &&
                  !isPreviewSidebarOpen &&
                  false &&
                  (canOpenPreview ? (
                    <Tooltip delayDuration={500}>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setIsPreviewSidebarOpen(true)}
                          className="h-6 w-6 p-0 hover:bg-foreground/10 transition-colors text-foreground flex-shrink-0 rounded-md ml-2"
                          aria-label="Open preview"
                        >
                          <IconOpenSidebarRight className="h-4 w-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Open preview</TooltipContent>
                    </Tooltip>
                  ) : (
                    <PreviewSetupHoverCard>
                      <span className="inline-flex ml-2">
                        <Button
                          variant="ghost"
                          size="icon"
                          disabled
                          className="h-6 w-6 p-0 text-muted-foreground flex-shrink-0 rounded-md cursor-not-allowed pointer-events-none"
                          aria-label="Preview not available"
                        >
                          <IconOpenSidebarRight className="h-4 w-4" />
                        </Button>
                      </span>
                    </PreviewSetupHoverCard>
                  ))}
                {/* Files button - opens the details sidebar on the Files
                    page (desktop only, unified sidebar only) */}
                {!isMobileFullscreen &&
                  isUnifiedSidebarEnabled &&
                  (worktreePath || sandboxId) && (
                    <Tooltip delayDuration={500}>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleToggleDetailsSidebarTab("files")}
                          className={cn(
                            "h-6 w-6 p-0 hover:bg-foreground/10 transition-colors flex-shrink-0 rounded-md ml-2",
                            isDetailsSidebarOpen && detailsSidebarTab === "files"
                              ? "text-foreground"
                              : "text-muted-foreground",
                          )}
                          aria-label="View files"
                        >
                          <Folder className="h-4 w-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">View files</TooltipContent>
                    </Tooltip>
                  )}
                {/* Overview/Terminal Button - shows when sidebar is closed and worktree/sandbox exists (desktop only) */}
                {!isMobileFullscreen &&
                  (worktreePath || sandboxId) && (
                    isUnifiedSidebarEnabled ? (
                      // Details button for unified sidebar
                      !isDetailsSidebarOpen && (
                        <Tooltip delayDuration={500}>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => {
                                setDetailsSidebarTab("details")
                                setIsDetailsSidebarOpen(true)
                              }}
                              className="h-6 w-6 p-0 hover:bg-foreground/10 transition-colors text-foreground flex-shrink-0 rounded-md ml-2"
                              aria-label="View details"
                            >
                              <IconOpenSidebarRight className="h-4 w-4" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent side="bottom">
                            View details
                            {toggleDetailsHotkey && <Kbd>{toggleDetailsHotkey}</Kbd>}
                          </TooltipContent>
                        </Tooltip>
                      )
                    ) : (
                      // Terminal button for legacy sidebars
                      !isTerminalSidebarOpen && (
                        <Tooltip delayDuration={500}>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => setIsTerminalSidebarOpen(true)}
                              className="h-6 w-6 p-0 hover:bg-foreground/10 transition-colors text-foreground flex-shrink-0 rounded-md ml-2"
                              aria-label="Open terminal"
                            >
                              <TerminalSquare className="h-4 w-4" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent side="bottom">
                            Open terminal
                            {toggleTerminalHotkey && <Kbd>{toggleTerminalHotkey}</Kbd>}
                          </TooltipContent>
                        </Tooltip>
                      )
                    )
                  )}
                {/* Restore Button - shows when viewing archived workspace (desktop only) */}
                {!isMobileFullscreen && isArchived && (
                  <Tooltip delayDuration={500}>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        onClick={handleRestoreWorkspace}
                        disabled={restoreWorkspaceMutation.isPending}
                        className="h-6 px-2 gap-1.5 hover:bg-foreground/10 transition-colors text-foreground flex-shrink-0 rounded-md ml-2 flex items-center"
                        aria-label="Restore workspace"
                      >
                        <UnarchiveIcon className="h-4 w-4" />
                        <span className="text-xs">Restore</span>
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      Restore workspace
                      <Kbd>⇧⌘E</Kbd>
                    </TooltipContent>
                  </Tooltip>
                )}
              </div>
            </div>
          )}

          {/* Chat Content - Keep-alive: render all open tabs, hide inactive with CSS */}
          {tabsToRender.length > 0 && agentChat ? (
            <div className="relative flex-1 min-h-0">
              {/* Loading gate: prevent getOrCreateChat() from caching empty messages before data is ready */}
              {isLocalChatLoading ? (
                <div className="flex items-center justify-center h-full">
                  <IconSpinner className="h-6 w-6 animate-spin" />
                </div>
              ) : splitPaneIds.length >= 2 && !!activeConversationId && splitPaneIds.includes(activeConversationId) ? (
                <SplitViewContainer
                  panes={splitPaneIds.flatMap((paneId) => {
                    const chat = getOrCreateChat(paneId)
                    const isFirstConversation = getFirstConversationId(agentConversations) === paneId
                    const belongsToWorkspace = agentConversations.some(sc => sc.id === paneId) ||
                                              allConversations.some(sc => sc.id === paneId)

                    if (!chat || !belongsToWorkspace) return []

                    return [{
                      id: paneId,
                      content: (
                        <div
                          className="h-full flex flex-col"
                          onMouseDownCapture={() => {
                            const store = useAgentConversationStore.getState()
                            if (store.activeConversationId !== paneId) {
                              // Mouse interaction already has an explicit target in this pane.
                              // Suppress auto-focus to avoid stealing focus from clicked controls
                              // (e.g. model selector popover trigger) on first click.
                              appStore.set(suppressInputFocusAtom, true)
                              store.setActiveConversation(paneId)
                            }
                          }}
                        >
                          <ChatViewInner
                            chat={chat}
                            conversationId={paneId}
                            parentChatId={chatId}
                            provider={inferProviderFromMessages(paneId)}
                            isFirstConversation={isFirstConversation}
                            onCreateNewConversation={handleCreateNewConversation}
                            onProviderChange={handleProviderChange}
                            teamId={selectedTeamId || undefined}
                            repository={repository}
                            isMobile={isMobileFullscreen}
                            isConversationsSidebarOpen={conversationsSidebarMode === "sidebar"}
                            sandboxId={sandboxId || undefined}
                            projectPath={worktreePath || undefined}
                            isArchived={isArchived}
                            onRestoreWorkspace={handleRestoreWorkspace}
                            existingPrUrl={agentChat?.prUrl}
                            isActive={paneId === activeConversationId}
                            isSplitPane={true}
                            isGroupMode={isGroupMode}
                            workspaceName={agentChat?.name ?? null}
                            workspaceBranch={agentChat?.branch ?? null}
                            workspaceRepoName={(agentChat as any)?.project?.gitRepo || (agentChat as any)?.project?.name || null}
                            workspaceId={agentChat?.workspaceId ?? null}
                            projectId={null}
                          />
                        </div>
                      )
                    }]
                  })}
                  hiddenTabs={
                    <>
                      {tabsToRender
                        .filter(id => !splitPaneIds.includes(id))
                        .map(conversationId => {
                          const chat = getOrCreateChat(conversationId)
                          const isFirstConversation = getFirstConversationId(agentConversations) === conversationId
                          const belongsToWorkspace = agentConversations.some(sc => sc.id === conversationId) ||
                                                    allConversations.some(sc => sc.id === conversationId)
                          if (!chat || !belongsToWorkspace) return null
                          return (
                            <div
                              key={conversationId}
                              className="absolute inset-0 flex flex-col"
                              style={{
                                opacity: 0,
                                pointerEvents: "none",
                                contain: "layout style paint",
                              }}
                              aria-hidden
                            >
                              <ChatViewInner
                                chat={chat}
                                conversationId={conversationId}
                                parentChatId={chatId}
                                provider={inferProviderFromMessages(conversationId)}
                                isFirstConversation={isFirstConversation}
                                onCreateNewConversation={handleCreateNewConversation}
                                onProviderChange={handleProviderChange}
                                teamId={selectedTeamId || undefined}
                                repository={repository}
                                isMobile={isMobileFullscreen}
                                isConversationsSidebarOpen={conversationsSidebarMode === "sidebar"}
                                sandboxId={sandboxId || undefined}
                                projectPath={worktreePath || undefined}
                                isArchived={isArchived}
                                onRestoreWorkspace={handleRestoreWorkspace}
                                existingPrUrl={agentChat?.prUrl}
                                isActive={false}
                                isSplitPane={false}
                                isGroupMode={isGroupMode}
                                workspaceName={agentChat?.name ?? null}
                                workspaceBranch={agentChat?.branch ?? null}
                                workspaceRepoName={(agentChat as any)?.project?.gitRepo || (agentChat as any)?.project?.name || null}
                                workspaceId={agentChat?.workspaceId ?? null}
                                projectId={null}
                              />
                            </div>
                          )
                        })}
                    </>
                  }
                />
              ) : (
                tabsToRender.map(conversationId => {
                const chat = getOrCreateChat(conversationId)
                const isActive = conversationId === activeConversationId
                const isFirstConversation = getFirstConversationId(agentConversations) === conversationId

                // Defense in depth: double-check workspace ownership
                // Use agentConversations (server data) as primary source, fall back to allConversations for optimistic updates
                // This fixes the race condition where allConversations is empty after setChatId but before setAllConversations
                const belongsToWorkspace = agentConversations.some(sc => sc.id === conversationId) ||
                                          allConversations.some(sc => sc.id === conversationId)

                if (!chat || !belongsToWorkspace) return null

                return (
                  <div
                    key={conversationId}
                    className="absolute inset-0 flex flex-col"
                    style={{
                      // GPU-accelerated visibility switching (нативное ощущение)
                      // transform + opacity быстрее чем visibility для GPU
                      transform: isActive ? "translateZ(0)" : "translateZ(0) scale(0.98)",
                      opacity: isActive ? 1 : 0,
                      // Prevent pointer events on hidden tabs
                      pointerEvents: isActive ? "auto" : "none",
                      // GPU layer hints
                      willChange: "transform, opacity",
                      // Изолируем layout - изменения внутри не влияют на другие табы
                      contain: "layout style paint",
                    }}
                    inert={!isActive}
                  >
                    <ChatViewInner
                      chat={chat}
                      conversationId={conversationId}
                      parentChatId={chatId}
                      provider={inferProviderFromMessages(conversationId)}
                      isFirstConversation={isFirstConversation}
                      onCreateNewConversation={handleCreateNewConversation}
                      onProviderChange={handleProviderChange}
                      teamId={selectedTeamId || undefined}
                      repository={repository}
                      isMobile={isMobileFullscreen}
                      isConversationsSidebarOpen={conversationsSidebarMode === "sidebar"}
                      sandboxId={sandboxId || undefined}
                      projectPath={worktreePath || undefined}
                      isArchived={isArchived}
                      onRestoreWorkspace={handleRestoreWorkspace}
                      existingPrUrl={agentChat?.prUrl}
                      isActive={isActive}
                      isSplitPane={false}
                      isGroupMode={isGroupMode}
                      workspaceName={agentChat?.name ?? null}
                      workspaceBranch={agentChat?.branch ?? null}
                      workspaceRepoName={(agentChat as any)?.project?.gitRepo || (agentChat as any)?.project?.name || null}
                      workspaceId={agentChat?.workspaceId ?? null}
                      projectId={null}
                    />
                  </div>
                )
              })
              )}
            </div>
          ) : (
            <>
              {/* Empty chat area - no loading indicator */}
              <div className="flex-1" />

              {/* Disabled input while loading */}
              <div className="px-2 pb-2">
                <div className="w-full max-w-2xl mx-auto">
                  <div className="relative w-full">
                    <PromptInput
                      className="border bg-input-background relative z-10 p-2 rounded-xl opacity-50 pointer-events-none"
                      maxHeight={200}
                    >
                      <div className="p-1 text-muted-foreground text-sm">
                        Plan, @ for context, / for commands
                      </div>
                      <PromptInputActions className="w-full">
                        <div className="flex items-center gap-0.5 flex-1 min-w-0">
                          {/* Mode selector placeholder */}
                          <button
                            disabled
                            className="flex items-center gap-1.5 px-2 py-1 text-sm text-muted-foreground rounded-md cursor-not-allowed"
                          >
                            <AgentIcon className="h-3.5 w-3.5" />
                            <span>Agent</span>
                            <ChevronDown className="h-3 w-3 shrink-0 opacity-50" />
                          </button>

                          {/* Model selector placeholder */}
                          <button
                            disabled
                            className="flex items-center gap-1.5 px-2 py-1 text-sm text-muted-foreground rounded-md cursor-not-allowed"
                          >
                            <ClaudeCodeIcon className="h-3.5 w-3.5" />
                            <span>
                              {hasCustomClaudeConfig ? (
                                "Custom Model"
                              ) : (
                                <>
                                  Sonnet{" "}
                                  <span className="text-muted-foreground">
                                    4.5
                                  </span>
                                </>
                              )}
                            </span>
                            <ChevronDown className="h-3 w-3 shrink-0 opacity-50" />
                          </button>
                        </div>
                        <div className="flex items-center gap-0.5 ml-auto flex-shrink-0">
                          {/* Attach button placeholder */}
                          <Button
                            variant="ghost"
                            size="icon"
                            disabled
                            className="h-7 w-7 rounded-sm cursor-not-allowed"
                          >
                            <AttachIcon className="h-4 w-4" />
                          </Button>

                          {/* Send button */}
                          <div className="ml-1">
                            <AgentSendButton
                              disabled={true}
                              onClick={() => {}}
                            />
                          </div>
                        </div>
                      </PromptInputActions>
                    </PromptInput>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>

        {/* Plan Sidebar - shows plan files on the right (leftmost right sidebar) */}
        {/* Only show when we have an active conversation with a plan */}
        {!isMobileFullscreen && activeConversationId && (
          <ResizableSidebar
            isOpen={isPlanSidebarOpen && !!currentPlanPath}
            onClose={() => setIsPlanSidebarOpen(false)}
            widthAtom={agentsPlanSidebarWidthAtom}
            minWidth={400}
            maxWidth={800}
            side="right"
            animationDuration={0.24}
            initialWidth={0}
            exitWidth={0}
            showResizeTooltip={true}
            className="bg-tl-background border-l"
            style={{ borderLeftWidth: "0.5px" }}
          >
            <AgentPlanSidebar
              chatId={chatId}
              conversationId={activeConversationId}
              planPath={currentPlanPath}
              onClose={() => setIsPlanSidebarOpen(false)}
              onBuildPlan={handleApprovePlanFromSidebar}
              mode={currentMode}
            />
          </ResizableSidebar>
        )}

        {/* Diff View - hidden on mobile fullscreen and when diff is not available */}
        {/* Supports three display modes: side-peek (sidebar), center-peek (dialog), full-page */}
        {/* Wrapped in DiffStateProvider to isolate diff state and prevent ChatView re-renders */}
        {canOpenDiff && !isMobileFullscreen && (
          <DiffStateProvider
            chatId={chatId}
            worktreePath={worktreePath}
            isDiffSidebarOpen={isDiffSidebarOpen}
            parsedFileDiffs={parsedFileDiffs}
            isDiffSidebarNarrow={isDiffSidebarNarrow}
            setIsDiffSidebarOpen={setIsDiffSidebarOpen}
            setDiffStats={setDiffStats}
            setDiffContent={setDiffContent}
            setParsedFileDiffs={setParsedFileDiffs}
            setPrefetchedFileContents={setPrefetchedFileContents}
            fetchDiffStats={fetchDiffStats}
          >
            <DiffSidebarRenderer
              worktreePath={worktreePath}
              chatId={chatId}
              sandboxId={sandboxId}
              repository={repository ?? null}
              diffStats={diffStats}
              diffContent={diffContent}
              parsedFileDiffs={parsedFileDiffs}
              prefetchedFileContents={prefetchedFileContents}
              setDiffCollapseState={setDiffCollapseState}
              diffViewRef={diffViewRef}
              diffSidebarRef={diffSidebarRef}
              agentChat={null}
              branchData={branchData}
              gitStatus={gitStatus}
              isGitStatusLoading={isGitStatusLoading}
              isDiffSidebarOpen={isDiffSidebarOpen}
              diffDisplayMode={diffDisplayMode}
              diffSidebarWidth={diffSidebarWidth}
              handleReview={handleReview}
              isReviewing={isReviewing}
              handleCreatePrDirect={handleCreatePrDirect}
              handleCreatePr={handleCreatePr}
              isCreatingPr={isCreatingPr}
              handleMergePr={handleMergePr}
              mergePrMutation={mergePrMutation}
              handleRefreshGitStatus={handleRefreshGitStatus}
              hasPrNumber={hasPrNumber}
              isPrOpen={isPrOpen}
              hasMergeConflicts={hasMergeConflicts}
              handleFixConflicts={handleFixConflicts}
              handleExpandAll={handleExpandAll}
              handleCollapseAll={handleCollapseAll}
              diffMode={diffMode}
              setDiffMode={setDiffMode}
              handleMarkAllViewed={handleMarkAllViewed}
              handleMarkAllUnviewed={handleMarkAllUnviewed}
              isDesktop={isDesktop}
              isFullscreen={isFullscreen ?? false}
              setDiffDisplayMode={setDiffDisplayMode}
              handleCommitToPr={handleCommitToPr}
              isCommittingToPr={isCommittingToPr}
              conversationsWithFiles={conversationsWithFiles}
              setDiffStats={setDiffStats}
              onDiscardSuccess={scheduleDiffRefresh}
            />
          </DiffStateProvider>
        )}

        {/* Preview Sidebar - hidden on mobile fullscreen and when preview is not available */}
        {canOpenPreview && !isMobileFullscreen && (
          <ResizableSidebar
            isOpen={isPreviewSidebarOpen}
            onClose={() => setIsPreviewSidebarOpen(false)}
            widthAtom={agentsPreviewSidebarWidthAtom}
            minWidth={350}
            side="right"
            animationDuration={0.24}
            initialWidth={0}
            exitWidth={0}
            showResizeTooltip={true}
            className="bg-tl-background border-l"
            style={{ borderLeftWidth: "0.5px" }}
          >
            {isQuickSetup ? (
              <div className="flex flex-col h-full">
                {/* Header with close button */}
                <div className="flex items-center justify-end px-3 h-10 bg-tl-background flex-shrink-0 border-b border-border/50">
                  <Button
                    variant="ghost"
                    className="h-7 w-7 p-0 hover:bg-muted transition-[background-color,transform] duration-150 ease-out active:scale-[0.97] rounded-md"
                    onClick={() => setIsPreviewSidebarOpen(false)}
                  >
                    <IconCloseSidebarRight className="h-4 w-4 text-muted-foreground" />
                  </Button>
                </div>
                {/* Content */}
                <div className="flex flex-col items-center justify-center flex-1 p-6 text-center">
                  <div className="text-muted-foreground mb-4">
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      width="48"
                      height="48"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="opacity-50"
                    >
                      <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                      <line x1="8" y1="21" x2="16" y2="21" />
                      <line x1="12" y1="17" x2="12" y2="21" />
                    </svg>
                  </div>
                  <p className="text-sm text-muted-foreground mb-2">
                    Preview not available
                  </p>
                  <p className="text-xs text-muted-foreground/70 max-w-[200px]">
                    Set up this repository to enable live preview
                  </p>
                </div>
              </div>
            ) : (
              <AgentPreview
                chatId={chatId}
                sandboxId={sandboxId}
                port={previewPort}
                hideHeader={false}
                onClose={() => setIsPreviewSidebarOpen(false)}
              />
            )}
          </ResizableSidebar>
        )}

        {/* File Viewer - opens when a file is clicked */}
        {!isMobileFullscreen && fileViewerPath && worktreePath && fileViewerDisplayMode === "side-peek" && (
          <ResizableSidebar
            isOpen={!!fileViewerPath}
            onClose={() => setLinkedFileViewerPath(null)}
            widthAtom={fileViewerSidebarWidthAtom}
            minWidth={350}
            maxWidth={900}
            side="right"
            animationDuration={0.24}
            initialWidth={0}
            exitWidth={0}
            outerResizeHandle
            showResizeTooltip={true}
            className="bg-tl-background border-l"
            style={{ borderLeftWidth: "0.5px" }}
          >
            <FileViewerSidebar
              filePath={fileViewerPath}
              projectPath={worktreePath}
              onClose={() => setLinkedFileViewerPath(null)}
            />
          </ResizableSidebar>
        )}
        {fileViewerPath && worktreePath && fileViewerDisplayMode === "center-peek" && (
          <DiffCenterPeekDialog
            isOpen={!!fileViewerPath}
            onClose={() => setLinkedFileViewerPath(null)}
          >
            <FileViewerSidebar
              filePath={fileViewerPath}
              projectPath={worktreePath}
              onClose={() => setLinkedFileViewerPath(null)}
            />
          </DiffCenterPeekDialog>
        )}
        {fileViewerPath && worktreePath && fileViewerDisplayMode === "full-page" && (
          <DiffFullPageView
            isOpen={!!fileViewerPath}
            onClose={() => setLinkedFileViewerPath(null)}
          >
            <FileViewerSidebar
              filePath={fileViewerPath}
              projectPath={worktreePath}
              onClose={() => setLinkedFileViewerPath(null)}
            />
          </DiffFullPageView>
        )}

        {/* Terminal Sidebar - shows when worktree exists (desktop only) */}
        {worktreePath && (
          <TerminalSidebar
            chatId={chatId}
            scopeKey={terminalScopeKey}
            cwd={worktreePath}
            workspaceId={chatId}
          />
        )}

        {/* Side Chat Sidebar - independent sidebar for agent side chats, coexists with Details */}
        {isUnifiedSidebarEnabled && !isMobileFullscreen && (
          <SideChatSidebar chatId={chatId} />
        )}

        {/* Unified Details Sidebar - combines all right sidebars into one (rightmost) */}
        {isUnifiedSidebarEnabled && !isMobileFullscreen && worktreePath && (
          <DetailsSidebar
            chatId={chatId}
            worktreePath={worktreePath}
            branch={meta?.branch ?? null}
            planPath={currentPlanPath}
            mode={currentMode}
            onBuildPlan={handleApprovePlanFromSidebar}
            activeConversationId={activeConversationId}
            isPlanSidebarOpen={isPlanSidebarOpen && !!currentPlanPath}
            isTerminalSidebarOpen={isTerminalSidebarOpen}
            isDiffSidebarOpen={isDiffSidebarOpen}
            diffDisplayMode={diffDisplayMode}
            canOpenDiff={canOpenDiff}
            diffStats={diffStats}
            parsedFileDiffs={parsedFileDiffs}
            onCommit={worktreePath ? handleCommitChanges : undefined}
            onCommitAndPush={worktreePath ? handleCommitAndPush : undefined}
            isCommitting={isCommittingCombined}
            gitStatus={gitStatus}
            isGitStatusLoading={isGitStatusLoading}
            currentBranch={branchData?.current}
            onExpandTerminal={() => {
              dispatchPanelLink({
                type: "open-panel",
                panelId: "terminal",
                source: "user",
                target: {
                  kind: "terminal",
                  id: terminalScopeKey,
                  chatId,
                  workspaceId: worktreePath ?? undefined,
                },
              })
              setIsTerminalSidebarOpen(true)
            }}
            onExpandPlan={() => {
              dispatchPanelLink({
                type: "open-panel",
                panelId: "plan",
                source: "user",
                target: currentPlanPath
                  ? {
                      kind: "plan",
                      id: currentPlanPath,
                      path: currentPlanPath,
                      chatId,
                      workspaceId: worktreePath ?? undefined,
                    }
                    : { kind: "plan", id: activeConversationId || chatId, chatId },
              })
              setIsPlanSidebarOpen(true)
            }}
            onExpandDiff={() => {
              dispatchPanelLink({
                type: "open-panel",
                panelId: "diff",
                source: "user",
                target: selectedFilePath
                  ? {
                      kind: "diff",
                      id: selectedFilePath,
                      path: selectedFilePath,
                      chatId,
                  workspaceId: worktreePath ?? undefined,
                    }
                  : { kind: "diff", id: chatId, chatId, workspaceId: worktreePath ?? undefined },
              })
              setIsDiffSidebarOpen(true)
            }}
            onFileSelect={(filePath) => {
              // Set the selected file path
              setSelectedFilePath(filePath)
              // Set filtered files to just this file
              setFilteredDiffFiles([filePath])
              // Open the diff sidebar
              setIsDiffSidebarOpen(true)
            }}
            onOpenFile={setLinkedFileViewerPath}
            hideResizeHandle={
              !!fileViewerPath && fileViewerDisplayMode === "side-peek"
            }
          />
        )}
      </div>

      {/* Terminal Bottom Panel — renders below the main row when displayMode is "bottom" */}
      {terminalDisplayMode === "bottom" && worktreePath && !isMobileFullscreen && (
        <ResizableBottomPanel
          isOpen={isTerminalSidebarOpen}
          onClose={() => setIsTerminalSidebarOpen(false)}
          heightAtom={terminalBottomHeightAtom}
          minHeight={150}
          maxHeight={500}
          showResizeTooltip={true}
          closeHotkey={toggleTerminalHotkey ?? undefined}
          className="bg-background border-t"
          style={{ borderTopWidth: "0.5px" }}
        >
          <TerminalBottomPanelContent
            chatId={chatId}
            scopeKey={terminalScopeKey}
            cwd={worktreePath}
            workspaceId={chatId}
            onClose={() => setIsTerminalSidebarOpen(false)}
          />
        </ResizableBottomPanel>
      )}
    </div>
    </TextSelectionProvider>
    </FileOpenProvider>
  )
}
