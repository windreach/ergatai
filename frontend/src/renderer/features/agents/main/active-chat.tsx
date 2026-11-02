"use client"
import { ChatViewSidebars } from "./active-chat-sidebars"
import {
  stripEmojis
} from "../../../components/chat-markdown-renderer"
import { Button } from "../../../components/ui/button"
import {
  AgentIcon,
  AttachIcon,
  ClaudeCodeIcon,
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
import type { RawMessage } from "../hooks/use-main-chat-invocation"
import type { MessagePart } from "../stores/message-store"
import {
  DiffStateProvider,
  DiffSidebarRenderer,
  useDiffState,
} from "../components/diff/diff-components"
import { useFileChangeListener, useGitWatcher } from "../../../lib/hooks/use-file-change-listener"
import { appStore } from "../../../lib/jotai-store"
import { api } from "../../../lib/api-adapter"
import { trpc } from "../../../lib/trpc"
import { cn } from "../../../lib/utils"
import { isDesktopApp } from "../../../lib/utils/platform"
import { useCommitActions } from "../../changes/components/commit-input"
import { DiffSidebarHeader } from "../../changes/components/diff-sidebar-header"
import { usePushAction } from "../../changes/hooks/use-push-action"
import {
  detailsSidebarOpenAtom,
  detailsSidebarTabAtom,
  sideChatSidebarOpenAtom,
  unifiedSidebarEnabledAtom,
} from "../../details-sidebar/atoms"
import {
  createPanelLinkScopeKey,
  panelLinkCommandAtomFamily,
} from "@/features/panel-link"
import { FileSearchDialog } from "../../file-viewer/components/file-search-dialog"
import { terminalBottomHeightAtom } from "../../terminal/atoms"
import { TerminalBottomPanelContent } from "../../terminal/terminal-sidebar"
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
  pendingInitialPromptAtomFamily,
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
import type { AgentQueueItem } from "../lib/queue-utils"
import { GroupChatProvider } from "../collaboration/group-chat-context"
import {
  isCollaborationSessionRuntimeEnabled,
  useCollaborationSession,
} from "../collaboration/collaboration-session-runtime"
import { extractAgentMentions } from "../collaboration/implicit-collaboration"
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
import { isPlanFile } from "../ui/agent-tool-utils"
import { type AgentUserQuestionHandle } from "../ui/agent-user-question"
import { AgentsHeaderControls } from "../ui/agents-header-controls"

// Extended chat type with Ergatai-specific fields
interface ExtendedAgentChat {
  id: string
  name?: string | null
  archivedAt?: Date | string | null
  worktreePath?: string | null
  collaborationMode?: "group" | "pair" | "individual" | null
  project?: {
    path?: string
    gitRepo?: string | null
    name?: string | null
  } | null
  branch?: string | null
  messages?: unknown[] // AI SDK Chat messages (runtime, not from backend)
  conversations?: Array<{
    id: string
    name?: string | null
    mode?: "plan" | "agent" | null
    created_at?: Date | string | null
    updated_at?: Date | string | null
    messages?: unknown
  }>
}
import { ChatTitleEditor } from "../ui/chat-title-editor"
import { MobileChatHeader } from "../ui/mobile-chat-header"
import { QuickCommentInput } from "../ui/quick-comment-input"
import { ConversationSelector } from "../ui/conversation-selector"
import { SplitViewContainer } from "../ui/split-view-container"
import { TextSelectionPopover } from "../ui/text-selection-popover"
import { generateCommitToPrMessage, generatePrMessage, generateReviewMessage } from "../utils/pr-message"
import { ChatInputArea } from "./chat-input-area"
import { ActiveChatDock } from "./active-chat-dock"
import { ActiveChatMessages } from "./active-chat-messages"
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

import { utf8ToBase64, base64ToUtf8 } from "../utils/base64"
import {
  clearRuntimeCachesForConversation,
  getFirstConversationId,
  CHAT_LAYOUT,
} from "./active-chat-helpers"
import { useActiveChatController } from "./use-active-chat-controller";

// Inner chat component - only rendered when chat object is ready
// Memoized to prevent re-renders when parent state changes (e.g., selectedFilePath)
const ChatViewInner = memo(function ChatViewInner(props: {
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
      persistedMessages?: RawMessage[]
    }) {
    const {
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
      persistedMessages,
    } = props

    const controller = useActiveChatController(props)
    const {
      groupAgents,
      setGroupAgents,
      handleGroupAgentsChange,
      groupContextValue,
      agentParticipants,
      implicitCollaborationTasks,
      isVisiblePane,
      agentBindingsQuery,
      backendAgentId,
      conversationRuntime,
      backendRuntimeMessages,
      pendingInitialPrompt,
      setPendingInitialPrompt,
      isVisiblePaneRef,
      conversationForBridge,
      chatInvocation,
      sessionState,
      invocationQueue,
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
      editorRef,
      fileInputRef,
      questionRef,
      prevChatKeyRef,
      prevConversationIdRef,
      pendingMention,
      setPendingMention,
      isRollingBack,
      setIsRollingBack,
      utils,
      conversationName,
      renameConversationMutation,
      renameConversationMutationRef,
      conversationNameRef,
      handleRenameConversation,
      conversationMode,
      setConversationMode,
      updateConversationModeMutation,
      handleModeChange,
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
      textContexts,
      diffTextContexts,
      addTextContextOriginal,
      addDiffTextContext,
      removeTextContext,
      removeDiffTextContext,
      clearTextContexts,
      clearDiffTextContexts,
      textContextsRef,
      diffTextContextsRef,
      setTextContextsFromDraft,
      setDiffTextContextsFromDraft,
      pastedTexts,
      addPastedText,
      addChatHistoryFile,
      removePastedText,
      clearPastedTexts,
      pastedTextsRef,
      setPastedTextsFromDraft,
      fileContentsRef,
      cacheFileContent,
      clearFileContents,
      queueCacheRef,
      queue,
      addToQueue,
      removeFromQueue,
      popItemFromQueue,
      planApprovalPending,
      setPlanApprovalPending,
      chatRef,
      chatMessages,
      sendMessage,
      status,
      stop,
      setMessages,
      messages,
      sendMessageRef,
      stopRef,
      isLocalStreaming,
      isInitialPromptBusy,
      isBackendStreaming,
      isRuntimeStreaming,
      isStreaming,
      streamingStatus,
      isStreamingRef,
      currentPlanPathAtom,
      setCurrentPlanPath,
      apiPlanPath,
      planLoading,
      refetchPlan,
      collaborationParticipants,
      collaborationSessionEnabled,
      collaborationSession,
      compactingConversations,
      isCompacting,
      isDesktop,
      isFullscreen,
      handleCompact,
      handleStop,
      addTextContext,
      handleFocusInput,
      quickCommentState,
      setQuickCommentState,
      handleQuickComment,
      handleQuickCommentSubmit,
      handleQuickCommentCancel,
      setLoadingConversations,
      isCreatingPr,
      setIsCreatingPr,
      pendingAuthRetry,
      setPendingAuthRetry,
      pendingBuildPlanConversationId,
      setPendingBuildPlanConversationId,
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
      clearPendingQuestionCallback,
      formatAnswersAsText,
      handleQuestionsAnswer,
      handleQuestionsSkip,
      handleSubmitWithQuestionAnswer,
      submitWithQuestionAnswerCallback,
      isSubmittingQuestionAnswerRef,
      handlePlanApproval,
      handleApprovePlan,
      detectedPrUrlRef,
      changedFilesForConversation,
      recomputeChangedFiles,
      handleRollback,
      handleForkFromMessage,
      isForkingRef,
      handleSend,
      handleSendFromQueue,
      handleRemoveFromQueue,
      handleForceSend,
      getMessageTextContent,
      copyMessageContent,
      hasUnapprovedPlan,
      setPendingPlanApprovals,
      stickyTopClass,
      searchBarTopOffset,
      shouldShowStatusCard,
      shouldShowStackedCards,
      hasPermissionApproval,
      setHasPermissionApproval,
      handleInputProviderChange,
      handleContinueWithProvider,
      isContinuingRef
    } = controller
  // Subscribe to backend-owned turns (such as new-chat initial prompts) so
  // they remain visible even though no local Chat transport started them.
  // Keep isActive in ref for use in callbacks (avoid stale closures)
  // Phase 10.3: Bridge hook for progressive migration to ConversationInvocationService
  // This hook combines the existing Chat instance (for message rendering) with
  // useConversationInvocation (for queue management)
  // Phase 16: Pass existing chat instance to avoid creating duplicate
  // Extract session state for future migration
  // Scroll management - handles auto-scroll, position tracking, and animation
  // Consume pending mentions from external components (e.g. MCP widget in sidebar)
  // Rollback state (global atom to prevent multiple rollbacks across chats)
  // tRPC utils for cache invalidation
  // Get conversation name from store
  // Mutation for renaming conversation
  // Handler for renaming conversation
  // Using ref for mutation to avoid callback recreation
  // Plan mode state (per-conversation? using atomFamily)
  // Mutation for updating conversation mode in database
  // Sync atomFamily mode to Zustand store on mount/conversationId change
  // This ensures the sidebar shows the correct mode icon
  // NOTE: We no longer clear caches on deactivation.
  // With proper conversationId isolation, each chat's caches are separate.
  // Caches are only cleared when no ChatViewInner instance is mounted for this conversation.
  // Handle mode changes - updates atomFamily, store, and database together
  // No effect needed - this is called directly when user toggles mode
  // File/image upload hook
  // Text context selection hook (for selecting text from assistant messages and diff)
  // Pasted text files (large pasted text saved as files)
  // Consume pending chat history file when this conversation is the target
  // File contents cache - stores content for file mentions (keyed by mentionId)
  // This content gets added to the prompt when sending, without showing a separate card
  // Clear file contents cache when switching conversations to prevent stale data
  // Phase 18: Use service-based queue system
  // Convert ConversationQueueItem[] to AgentQueueItem[] for UI compatibility
  // Use a ref to cache the previous conversion and only update when content actually changes
  // Plan approval pending state (for tool approval loading)
  // Track chat changes for rename trigger reset
  // Restore draft when conversationId changes (switching between conversations)
  // Use conversationId as stable key to prevent HMR-induced duplicate resume requests
  // Main chat now shares the side-chat rendering contract: merged persisted +
  // runtime messages are read through RuntimeSessionStore.visibleMessages.
  // The local Chat messages remain the fallback while the session is initializing.
  // Refs for useChat functions to keep callbacks stable across renders
  // The scheduler state covers agent startup; runtime streaming covers the
  // actual ACP turn. Once either says the turn is live/done, retire the handle.
  // Backend-owned turns have no local useChat status transition. Present them
  // to rendering and state UI as streaming as soon as the runtime emits a turn.
  // Ref for isStreaming to use in callbacks/effects that need fresh value
  // Fetch plan from backend API instead of scanning messages
  // Update atom when API returns plan path
  // Refetch plan when streaming completes
  // Listen for plan update events from AgentPlanFileTool
  // Collaboration participants - creates conversations for each agent in group mode
  // Track compacting status from SDK
  // Desktop/fullscreen state for window drag region
  // Handler to trigger manual context compaction
  // Handler to stop streaming - memoized to prevent ChatInputArea re-renders
  // Wrapper for addTextContext that handles TextSelectionSource
  // Focus handler for text selection popover - focus chat input after adding to context
  // Custom event listeners for file-viewer and file-tree interactions
  // Quick comment handlers
  // Sync loading status to atom for UI indicators
  // When streaming starts, set loading. When it stops, clear loading.
  // Unseen changes, sound notification, and sidebar refresh are handled in onFinish callback
  // Extract pending actions into a hook
  // Handle pending "Build plan" from sidebar (atom - effect is defined after handleApprovePlan)
  // Pending user questions from AskUserQuestion tool
  // Question handling and token data computation
  // Helper to clear pending and expired questions for this conversation? (used in callbacks)
  // Shared helpers for question answer handlers
  // Question answering handlers
  // Pending auth retry - retries sending message after OAuth success
  // Plan approval handlers
  // Handle pending "Build plan" from sidebar
  // PR detection
  // Rollback - handles rolling back to a previous message
  // Fork handler - creates a new conversation with messages up to this point
  // Preserves SDK session context by copying .jsonl session files
  // Fork conversation - handles forking from a specific message
  // Keyboard shortcuts for stopping stream (ESC, Ctrl+C, Cmd+Shift+Backspace)
  // Keyboard shortcut: Enter to focus input when not already focused
  // Keyboard shortcut: Cmd+Esc to toggle focus/blur (without stopping generation)
  // Scroll initialization, auto-scroll, and position restoration
  // Message sending handlers
  // Phase 10.3: Currently using useMessageSending for complex logic (inputRefs, actions, queue, messaging).
  // Future phases will migrate to chatInvocation.handleSend and chatInvocation.handleSendFromQueue
  // as the bridge hook matures to support all the required features.
  // NOTE: Auto-processing of queue is now handled globally by QueueProcessor
  // component in agents-layout.tsx. This ensures queues continue processing
  // even when user navigates to different conversations or workspaces.

  // Helper to get message text content
  // Helper to copy message content
  // Unapproved plan detection - checks for ExitPlanMode and manages sidebar indicators
  // Cmd/Ctrl + Arrow Down to scroll to bottom shortcut
  // Get setter for pending plan approvals (for cleanup on unmount)
  // Clean up pending plan approval when unmounting
  // Compute sticky top class for user messages
  // Sync messages to Jotai store and streaming status
  // Chat search - scroll to current match
  // Calculate top offset for search bar based on conversation selector
  // Provider selection - handles switching between claude-code and codex providers
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
      <ActiveChatMessages
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
        chatContainerRef={chatContainerRef}
        chatContainerObserverRef={chatContainerObserverRef}
        contentWrapperRef={contentWrapperRef}
        implicitCollaborationTasks={implicitCollaborationTasks}
        collaborationSession={collaborationSession}
        handleRollback={handleRollback}
        handleForkFromMessage={handleForkFromMessage}
      />

      <ActiveChatDock
        isVisiblePane={isVisiblePane}
        parentChatId={parentChatId}
        conversationId={conversationId}
        setHasPermissionApproval={setHasPermissionApproval}
        hasPermissionApproval={hasPermissionApproval}
        displayQuestions={displayQuestions}
        questionRef={questionRef}
        handleQuestionsAnswer={handleQuestionsAnswer}
        handleQuestionsSkip={handleQuestionsSkip}
        inputHasContent={inputHasContent}
        queue={queue}
        handleRemoveFromQueue={handleRemoveFromQueue}
        handleSendFromQueue={handleSendFromQueue}
        shouldShowStatusCard={shouldShowStatusCard}
        shouldShowStackedCards={shouldShowStackedCards}
        isStreaming={isStreaming}
        isCompacting={isCompacting}
        changedFilesForConversation={changedFilesForConversation}
        projectPath={projectPath}
        handleStop={handleStop}
        editorRef={editorRef}
        fileInputRef={fileInputRef}
        handleSend={handleSend}
        handleForceSend={handleForceSend}
        handleCompact={handleCompact}
        onCreateNewConversation={onCreateNewConversation}
        handleModeChange={handleModeChange}
        images={images}
        files={files}
        handleAddAttachments={handleAddAttachments}
        handleAddFolder={handleAddFolder}
        removeImage={removeImage}
        removeFile={removeFile}
        isUploading={isUploading}
        textContexts={textContexts}
        removeTextContext={removeTextContext}
        diffTextContexts={diffTextContexts}
        removeDiffTextContext={removeDiffTextContext}
        pastedTexts={pastedTexts}
        addPastedText={addPastedText}
        removePastedText={removePastedText}
        cacheFileContent={cacheFileContent}
        messageTokenData={messageTokenData}
        provider={provider}
        backendAgentId={backendAgentId}
        teamId={teamId}
        repository={repository}
        sandboxId={sandboxId}
        isMobile={isMobile}
        setInputHasContent={setInputHasContent}
        submitWithQuestionAnswerCallback={submitWithQuestionAnswerCallback}
        handleInputProviderChange={handleInputProviderChange}
        handleContinueWithProvider={handleContinueWithProvider}
        isActive={isActive}
        isGroupMode={isGroupMode}
        handleGroupAgentsChange={handleGroupAgentsChange}
        chatContainerRef={chatContainerRef}
        scrollToBottom={scrollToBottom}
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
    messages?: UIMessage[] | string
  }>

  // Parse the durable chat snapshot once per query result. This gives the
  // runtime session cache a history source that is independent of the local
  // streaming Chat instance.
  const persistedMessagesByConversationId = useMemo(() => {
    const messagesById = new Map<string, unknown[]>()

    for (const conversation of agentConversations) {
      const rawMessages = conversation.messages
      let parsedMessages: unknown[] = []

      if (Array.isArray(rawMessages)) {
        parsedMessages = rawMessages
      } else if (typeof rawMessages === "string") {
        try {
          const parsed = JSON.parse(rawMessages)
          parsedMessages = Array.isArray(parsed) ? parsed : []
        } catch {
          parsedMessages = []
        }
      }

      messagesById.set(conversation.id, parsedMessages)
    }

    return messagesById
  }, [agentConversations])

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
  const isGroupMode = (agentChat as ExtendedAgentChat | undefined)?.collaborationMode === "group"

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
  const originalProjectPath = (agentChat as ExtendedAgentChat | undefined)?.project?.path as string | undefined

  // Terminal scope key: shared by project path (local mode) or isolated per workspace (worktree)
  const terminalScopeKey = useMemo(() => {
    return getTerminalScopeKey({
      branch: (agentChat as ExtendedAgentChat | undefined)?.branch ?? null,
      worktreePath: worktreePath,
      id: chatId,
    })
  }, [(agentChat as ExtendedAgentChat | undefined)?.branch, worktreePath, chatId])
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

      const conversation = ((agentChat as ExtendedAgentChat | undefined)?.conversations || []).find(
        (sc: { id?: string }) => sc?.id === conversationId,
      ) as { messages?: unknown } | undefined
      const rawMessages = conversation?. messages

      let messages: unknown[] = []
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
        const model = (message as { metadata?: Record<string, unknown> })?.metadata?.model
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
      trpcUtils,
      fetchDiffStatsRef,
      forceUpdate,
    },
  })

  const handleProviderChange = useCallback(
    (conversationId: string, nextProvider: "claude-code" | "codex") => {
      // Provider switch is only allowed for brand new conversations.
      const activeChat = agentChatStore.get(conversationId) as ExtendedAgentChat | undefined
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
                            workspaceRepoName={(agentChat as unknown as ExtendedAgentChat | undefined)?.project?.gitRepo || (agentChat as unknown as ExtendedAgentChat | undefined)?.project?.name || null}
                            workspaceId={agentChat?.workspaceId ?? null}
                            projectId={null}
                            persistedMessages={(persistedMessagesByConversationId.get(paneId) ?? []) as unknown as RawMessage[]}
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
                                workspaceRepoName={(agentChat as unknown as ExtendedAgentChat | undefined)?.project?.gitRepo || (agentChat as unknown as ExtendedAgentChat | undefined)?.project?.name || null}
                                workspaceId={agentChat?.workspaceId ?? null}
                                projectId={null}
                                persistedMessages={(persistedMessagesByConversationId.get(conversationId) ?? []) as unknown as RawMessage[]}
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
                      workspaceRepoName={(agentChat as unknown as ExtendedAgentChat | undefined)?.project?.gitRepo || (agentChat as unknown as ExtendedAgentChat | undefined)?.project?.name || null}
                      workspaceId={agentChat?.workspaceId ?? null}
                      projectId={null}
                      persistedMessages={(persistedMessagesByConversationId.get(conversationId) ?? []) as unknown as RawMessage[]}
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

        <ChatViewSidebars
          isMobileFullscreen={isMobileFullscreen}
          activeConversationId={activeConversationId}
          isPlanSidebarOpen={isPlanSidebarOpen}
          setIsPlanSidebarOpen={setIsPlanSidebarOpen}
          currentPlanPath={currentPlanPath}
          handleApprovePlanFromSidebar={handleApprovePlanFromSidebar}
          currentMode={currentMode}
          canOpenDiff={canOpenDiff}
          chatId={chatId}
          worktreePath={worktreePath}
          sandboxId={sandboxId}
          repository={repository}
          isDiffSidebarOpen={isDiffSidebarOpen}
          setIsDiffSidebarOpen={setIsDiffSidebarOpen}
          diffStats={diffStats}
          setDiffStats={setDiffStats}
          diffContent={diffContent}
          setDiffContent={setDiffContent}
          parsedFileDiffs={parsedFileDiffs}
          setParsedFileDiffs={setParsedFileDiffs}
          prefetchedFileContents={prefetchedFileContents}
          setPrefetchedFileContents={setPrefetchedFileContents}
          fetchDiffStats={fetchDiffStats}
          isDiffSidebarNarrow={isDiffSidebarNarrow}
          setDiffCollapseState={setDiffCollapseState}
          diffViewRef={diffViewRef}
          diffSidebarRef={diffSidebarRef}
          branchData={branchData}
          gitStatus={gitStatus}
          isGitStatusLoading={isGitStatusLoading}
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
          isFullscreen={isFullscreen}
          setDiffDisplayMode={setDiffDisplayMode}
          handleCommitToPr={handleCommitToPr}
          isCommittingToPr={isCommittingToPr}
          conversationsWithFiles={conversationsWithFiles}
          scheduleDiffRefresh={scheduleDiffRefresh}
          canOpenPreview={canOpenPreview}
          isPreviewSidebarOpen={isPreviewSidebarOpen}
          setIsPreviewSidebarOpen={setIsPreviewSidebarOpen}
          isQuickSetup={isQuickSetup}
          previewPort={previewPort}
          setLinkedFileViewerPath={setLinkedFileViewerPath}
          fileViewerPath={fileViewerPath}
          fileViewerDisplayMode={fileViewerDisplayMode}
          terminalScopeKey={terminalScopeKey}
          isUnifiedSidebarEnabled={isUnifiedSidebarEnabled}
          meta={meta}
          isTerminalSidebarOpen={isTerminalSidebarOpen}
          setIsTerminalSidebarOpen={setIsTerminalSidebarOpen}
          terminalDisplayMode={terminalDisplayMode}
          toggleTerminalHotkey={toggleTerminalHotkey}
          isCommittingCombined={isCommittingCombined}
          dispatchPanelLink={dispatchPanelLink}
          selectedFilePath={selectedFilePath}
          setSelectedFilePath={setSelectedFilePath}
          setFilteredDiffFiles={setFilteredDiffFiles}
          handleCommitChanges={handleCommitChanges}
          handleCommitAndPush={handleCommitAndPush}
        />
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
