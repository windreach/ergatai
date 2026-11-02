import {
  stripEmojis
} from "../../../components/chat-markdown-renderer"
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
import {
  PromptInput,
  PromptInputActions
} from "../../../components/ui/prompt-input"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../../../components/ui/tooltip"
import {Chat, useChat} from "@ai-sdk/react"
import {useAtom, useAtomValue, useSetAtom} from "jotai"
import {
  ArrowDown,
  ChevronDown,
  Folder,
  GitFork,
  TerminalSquare
} from "lucide-react"
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
import { usePendingActions } from "../hooks/use-pending-actions"
import { useQuestionHandling } from "../hooks/use-question-handling"
import { useQuestionAnswers } from "../hooks/use-question-answers"
import { useMessageSending } from "../hooks/use-message-sending"
import { usePlanApproval } from "../hooks/use-plan-approval"
import { useQuickComment } from "../hooks/use-quick-comment"
import { usePrDetection } from "../hooks/use-pr-detection"
import {useScrollManagement} from "../hooks/use-scroll-management"
import { useProviderSelection } from "../hooks/use-provider-selection"
import { useCollaborationParticipants } from "../hooks/use-collaboration-participants"
import { useUnapprovedPlanDetection } from "../hooks/use-unapproved-plan-detection"
import { useForkConversation } from "../hooks/use-fork-conversation"
import { useRollback } from "../hooks/use-rollback"
import { useDraftRecovery } from "../hooks/use-draft-recovery"
import { useSearchScroll } from "../hooks/use-search-scroll"
import { useKeyboardStop } from "../hooks/use-keyboard-stop"
import { useScrollInit } from "../hooks/use-scroll-init"
import { useCustomEventListeners } from "../hooks/use-custom-event-listeners"
import { useScrollToBottomShortcut } from "../hooks/use-scroll-to-bottom-shortcut"
import { useMessageSync } from "../hooks/use-message-sync"
import { useMainChatInvocation } from "../hooks/use-main-chat-invocation"
import type { RawMessage } from "../hooks/use-main-chat-invocation"
import type { MessagePart } from "../stores/message-store"
import {
  DiffStateProvider,
  DiffSidebarRenderer,
  useDiffState,
} from "../components/diff/diff-components"
import { useConversationRuntime } from "../../details-sidebar/lib/conversation-runtime-gateway"
import { buildRuntimeMessages } from "../../details-sidebar/lib/conversation-runtime-ui"
import { api } from "../../../lib/api-adapter"
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
import type { TextSelectionSource } from "../context/text-selection-context"
import { useActiveChatPlan } from "./use-active-chat-plan"
import { useActiveChatAttachments } from "./use-active-chat-attachments"
import { useActiveChatQueue } from "./use-active-chat-queue"
import { useActiveChatCollaboration } from "./use-active-chat-collaboration"
import { useActiveChatEffects } from "./use-active-chat-effects"
import { useActiveChatConversationMeta } from "./use-active-chat-conversation-meta"
import { trpcClient } from "../../../lib/trpc"
import type { AgentUserQuestionHandle } from "../ui/agent-user-question"
import { useChangedFilesTracking } from "../hooks/use-changed-files-tracking"
import { useFocusInputOnEnter } from "../hooks/use-focus-input-on-enter"
import { useToggleFocusOnCmdEsc } from "../hooks/use-toggle-focus-on-cmd-esc"
import { usePendingAuthRetry } from "../hooks/use-pending-auth-retry"
import type { AgentQueueItem } from "../lib/queue-utils"
import {
  isCollaborationSessionRuntimeEnabled,
  useCollaborationSession,
} from "../collaboration/collaboration-session-runtime"
import { extractAgentMentions } from "../collaboration/implicit-collaboration"
import {
  setGroupAgentRuntimeStatuses,
  type GroupAgentRuntimeStatuses,
} from "../collaboration/group-agent-runtime"
import {
  getCoreAgentProfileName,
  type CoreAgentOption,
} from "../lib/agent-contract-api"
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
import {useMessageQueueStore} from "../stores/message-queue-store"
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
import {
  AgentDiffView,
  diffViewModeAtom,
  splitUnifiedDiffByFile,
  type AgentDiffViewRef,
  type ParsedDiffFile,
} from "../ui/agent-diff-view"
import {
  clearRuntimeCachesForConversation,
  getFirstConversationId,
  CHAT_LAYOUT,
} from "./active-chat-helpers"

const mountedChatViewInnerCounts = new Map<string, number>()
const pendingConversationCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>()

export function useActiveChatController(props: {
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

const {
    groupAgents,
    setGroupAgents,
    handleGroupAgentsChange,
    groupContextValue,
    agentParticipants,
    implicitCollaborationTasks,
    agentBindingsQuery,
    isVisiblePane,
  } = useActiveChatCollaboration({
    isGroupMode,
    parentChatId,
    projectPath,
    workspaceId,
    provider,
    conversationId,
    isActive,
    isSplitPane,
  })

const backendAgentId = useMemo(() => {
    // Try to find by conversationId first, then fall back to chatId
    const byConversation = agentBindingsQuery.data?.find(
      (binding) => binding.conversationId === conversationId,
    )
    const byChat = agentBindingsQuery.data?.find(
      (binding) => binding.chatId === parentChatId,
    )
    return byConversation?.agentId ?? byChat?.agentId ?? null
  }, [agentBindingsQuery.data, conversationId, parentChatId])

const conversationRuntime = useConversationRuntime(conversationId, isVisiblePane)

const backendRuntimeMessages = useMemo(
    () => buildRuntimeMessages(conversationRuntime),
    [conversationRuntime],
  )

const [pendingInitialPrompt, setPendingInitialPrompt] = useAtom(
    pendingInitialPromptAtomFamily(conversationId),
  )

const isVisiblePaneRef = useRef(isVisiblePane)

isVisiblePaneRef.current = isVisiblePane

const conversationForBridge = useMemo(() => ({
    id: conversationId,
    backendConversationId: conversationId,
  }), [conversationId])

const chatInvocation = useMainChatInvocation({
    conversation: conversationForBridge as unknown as Parameters<typeof useMainChatInvocation>[0]["conversation"],
    chatId: parentChatId,
    agentId: provider,
    isActive,
    persistedMessages,
    runtimeMessages: backendRuntimeMessages as unknown as Parameters<typeof useMainChatInvocation>[0]["runtimeMessages"],
    existingChat: chat, // Pass existing Chat instance to avoid duplicate
  })

const { sessionState, invocationQueue } = chatInvocation

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

const [pendingMention, setPendingMention] = useAtom(pendingMentionAtom)

useEffect(() => {
    // Only active pane should consume a global pending mention.
    // This prevents duplicate insertion across keep-alive/split panes.
    if (!isActive || !pendingMention) return
    editorRef.current?.insertMention(pendingMention)
    editorRef.current?.focus()
    setPendingMention(null)
  }, [isActive, pendingMention, setPendingMention])

const [isRollingBack, setIsRollingBack] = useAtom(isRollingBackAtom)

const utils = api.useUtils()

const {
    conversationName,
    conversationNameRef,
    renameConversationMutation,
    renameConversationMutationRef,
    handleRenameConversation,
    conversationMode,
    setConversationMode,
    updateConversationModeMutation,
    handleModeChange,
  } = useActiveChatConversationMeta({
    conversationId,
    parentChatId,
    utils,
  })

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
  } = useActiveChatAttachments({ conversationId })

const {
    queueCacheRef,
    queue,
    addToQueue,
    removeFromQueue,
    popItemFromQueue,
    planApprovalPending,
    setPlanApprovalPending,
  } = useActiveChatQueue({ invocationQueue, chatInvocation })

const chatRef = useRef<Chat<any> | null>(null)

if (prevConversationIdRef.current !== conversationId) {
    prevConversationIdRef.current = conversationId
  }

chatRef.current = chat

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

const { messages: chatMessages, sendMessage, status, stop, setMessages } = useChat({
    id: conversationId,
    chat,
    experimental_throttle: 50,  // Throttle updates to reduce re-renders during streaming
  })

const messages = chatInvocation.messages?.length
    ? chatInvocation.messages
    : chatMessages

const sendMessageRef = useRef(sendMessage)

sendMessageRef.current = sendMessage

const stopRef = useRef(stop)

stopRef.current = stop

const isLocalStreaming = status === "streaming" || status === "submitted"

const isInitialPromptBusy =
    pendingInitialPrompt?.status === "pending" ||
    pendingInitialPrompt?.status === "dispatching" ||
    pendingInitialPrompt?.status === "running"

const isBackendStreaming =
    isInitialPromptBusy ||
    conversationRuntime?.status === "streaming" ||
    sessionState?.isStreaming === true

const isRuntimeStreaming =
    conversationRuntime?.status === "streaming" ||
    sessionState?.isStreaming === true

const isStreaming = isLocalStreaming || isBackendStreaming


const streamingStatus = isLocalStreaming
    ? status
    : isStreaming
      ? "streaming"
      : status

const isStreamingRef = useRef(isStreaming)

isStreamingRef.current = isStreaming

const {
    currentPlanPathAtom,
    setCurrentPlanPath,
    apiPlanPath,
    planLoading,
    refetchPlan,
  } = useActiveChatPlan({
    conversationId,
    parentChatId,
    status,
    isStreaming,
  })

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
    supervisorAgentId: backendAgentId,
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

const compactingConversations = useAtomValue(compactingConversationsAtom)

const isCompacting = compactingConversations.has(conversationId)

const isDesktop = useAtomValue(isDesktopAtom)

const isFullscreen = useAtomValue(isFullscreenAtom)

const handleCompact = useCallback(() => {
    if (isStreamingRef.current) return // Can't compact while streaming
    sendMessageRef.current({
      role: "user",
      parts: [{ type: "text", text: "/compact" }],
    })
  }, [])

const handleStop = useCallback(async () => {
    // Backend-owned turns never entered the local AI SDK Chat transport, so
    // cancel the runtime prompt directly using the bound agent.
    if (isBackendStreaming && backendAgentId) {
      await trpcClient.ergatai.cancelPrompt
        .mutate({ agentId: backendAgentId })
        .catch((error) => {
          console.warn("[ActiveChat] Failed to cancel backend prompt:", error)
        })
      return
    }

    // Mark as manually aborted to prevent completion sound
    agentChatStore.setManuallyAborted(conversationId, true)
    await stopRef.current()
  }, [backendAgentId, conversationId, isBackendStreaming])

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

const handleFocusInput = useCallback(() => {
    editorRef.current?.focus()
  }, [])

useCustomEventListeners({
    isActive,
    addTextContext,
    editorRef,
  })

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

const setLoadingConversations = useSetAtom(loadingConversationsAtom)

useActiveChatEffects({
    conversationId,
    isStreaming,
    isRuntimeStreaming,
    messages,
    pendingInitialPrompt,
    setPendingInitialPrompt,
    conversationRuntime,
    setLoadingConversations,
  })

const { isCreatingPr, setIsCreatingPr, pendingAuthRetry, setPendingAuthRetry } = usePendingActions({
    conversationId,
    isStreaming,
    sendMessage,
  })

const [pendingBuildPlanConversationId, setPendingBuildPlanConversationId] = useAtom(
    pendingBuildPlanConversationIdAtom,
  )

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

usePendingAuthRetry({
    pendingAuthRetry,
    conversationId,
    provider,
    isStreaming,
    sendMessage,
    setPendingAuthRetry,
  })

const { handlePlanApproval, handleApprovePlan } = usePlanApproval({
    conversationId,
    setConversationMode,
    scrollToBottom,
    updateConversationModeMutation,
    sendMessageRef,
  })

useEffect(() => {
    // Only trigger if this is the target conversation and we're active
    if (pendingBuildPlanConversationId === conversationId && isActive) {
      setPendingBuildPlanConversationId(null) // Clear immediately to prevent double-trigger
      handleApprovePlan()
    }
  }, [pendingBuildPlanConversationId, conversationId, isActive, setPendingBuildPlanConversationId, handleApprovePlan])

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

const { handleForkFromMessage, isForkingRef } = useForkConversation({
    conversationId,
    parentChatId,
    isStreaming,
    messages,
  })

useKeyboardStop({
    isActive,
    isStreaming,
    conversationId,
    stop,
    displayQuestions,
    handleQuestionsSkip,
  })

useFocusInputOnEnter(editorRef, isActive)

useToggleFocusOnCmdEsc(editorRef, isActive)

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
    status: streamingStatus,
    messages,
    editorRef,
  })

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

const getMessageTextContent = (msg: { parts?: MessagePart[] }): string => {
    return (
      msg.parts
        ?.filter((p: MessagePart) => p.type === "text")
        .map((p: MessagePart) => p.text)
        .join("\n") || ""
    )
  }

const copyMessageContent = (msg: { parts?: MessagePart[] }) => {
    const textContent = getMessageTextContent(msg)
    if (textContent) {
      navigator.clipboard.writeText(stripEmojis(textContent))
    }
  }

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

useScrollToBottomShortcut({
    isActive,
    scrollToBottom,
    editorRef,
  })

const setPendingPlanApprovals = useSetAtom(pendingPlanApprovalsAtom)


const stickyTopClass = isMobile
    ? CHAT_LAYOUT.stickyTopMobile
    : isConversationsSidebarOpen
      ? CHAT_LAYOUT.stickyTopSidebarOpen
      : CHAT_LAYOUT.stickyTopSidebarClosed

useMessageSync({
    conversationId,
    messages,
    status: streamingStatus,
    isActive,
    isSplitPane,
  })

useSearchScroll({ chatContainerRef })

const searchBarTopOffset = isConversationsSidebarOpen ? "52px" : undefined

const shouldShowStatusCard =
    isStreaming || isCompacting || changedFilesForConversation.length > 0

const shouldShowStackedCards =
    !displayQuestions && (queue.length > 0 || shouldShowStatusCard)

const [hasPermissionApproval, setHasPermissionApproval] = useState(false)

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
    conversationNameRef,
  })

  return {
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
    isContinuingRef,
  }
}
