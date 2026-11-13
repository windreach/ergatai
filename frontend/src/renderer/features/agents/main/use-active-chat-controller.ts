






import {Chat, useChat} from "@ai-sdk/react"
import {useAtom, useAtomValue, useSetAtom} from "jotai"


import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react"
import { trackMessageSent } from "../../../lib/analytics"
import {
  isDesktopAtom, isFullscreenAtom
} from "../../../lib/atoms"


import { useMessageSending } from "../hooks/use-message-sending"
import { useQuickComment } from "../hooks/use-quick-comment"

import { useCollaborationParticipants } from "../hooks/use-collaboration-participants"



import { useDraftRecovery } from "../hooks/use-draft-recovery"
import { useSearchScroll } from "../hooks/use-search-scroll"
import { useKeyboardStop } from "../hooks/use-keyboard-stop"
import { useScrollInit } from "../hooks/use-scroll-init"
import { useCustomEventListeners } from "../hooks/use-custom-event-listeners"
import { useScrollToBottomShortcut } from "../hooks/use-scroll-to-bottom-shortcut"
import { useMessageSync } from "../hooks/use-message-sync"
import { useMainChatInvocation } from "../hooks/use-main-chat-invocation"
import { useConversationChatSurface } from "./use-conversation-chat-surface"
import type { RawMessage } from "../hooks/use-main-chat-invocation"
import type { MessagePart } from "../stores/message-store"


import { useConversationRuntime } from "../../details-sidebar"
import { buildRuntimeMessages } from "../../details-sidebar"
import { api } from "../../../lib/api-adapter"




import {
  compactingConversationsAtom,
  loadingConversationsAtom,
  pendingMentionAtom,
  pendingInitialPromptAtomFamily,
  pendingPlanApprovalsAtom
} from "../atoms"
import type { TextSelectionSource } from "../context/text-selection-context"
import { useActiveChatPlan } from "./use-active-chat-plan"
import { useActiveChatQueue } from "./use-active-chat-queue"
import { useActiveChatCollaboration } from "./use-active-chat-collaboration"
import { useActiveChatEffects } from "./use-active-chat-effects"
import { useConversationLifecycle } from "./use-conversation-lifecycle"

import { trpcClient } from "../../../lib/trpc"
import type { AgentUserQuestionHandle } from "../ui/agent-user-question"

import { useFocusInputOnEnter } from "../hooks/use-focus-input-on-enter"
import { useToggleFocusOnCmdEsc } from "../hooks/use-toggle-focus-on-cmd-esc"

import {
  isCollaborationSessionRuntimeEnabled,
  useCollaborationSession,
} from "../collaboration/collaboration-session-runtime"
import { extractAgentMentions } from "../collaboration/implicit-collaboration"
import {
  setGroupAgentRuntimeStatuses,
} from "../collaboration/group-agent-runtime"


import {
  clearConversationDraft
} from "../lib/drafts"

import {
  type AgentsMentionsEditorHandle,
} from "../mentions"


import { agentChatStore } from "../stores/agent-chat-store"
import {useMessageQueueStore} from "../stores/message-queue-store"
import {
  isRollingBackAtom
} from "../stores/message-store"
import { useStreamingStatusStore } from "../stores/streaming-status-store"
import {
  useAgentConversationStore,
} from "../stores/conversation-store"


import {
  CHAT_LAYOUT,
} from "./active-chat-helpers"



 
// react-doctor-disable-next-line no-high-complexity-react-function
export function useActiveChatController(props: {
  chat: Chat<any>
  conversationId: string
  parentChatId: string
  provider?: "claude-code" | "codex" | "opencode"
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
  persistedMessagesLoading?: boolean
}) {
  const {
  chat,
  conversationId,
  parentChatId,
  provider = "claude-code",
  isFirstConversation: _isFirstConversation,
  onCreateNewConversation: _onCreateNewConversation,
  onProviderChange,
  refreshDiff,
  teamId,
  repository: _repository,
  isMobile = false,
  sandboxSetupStatus = "ready",
  sandboxSetupError: _sandboxSetupError,
  onRetrySetup: _onRetrySetup,
  isConversationsSidebarOpen = false,
  sandboxId: _sandboxId,
  projectPath,
  isArchived = false,
  onRestoreWorkspace,
  existingPrUrl,
  isActive = true,
  isSplitPane = false,
  isGroupMode = false,
  workspaceName: _workspaceName,
  workspaceBranch: _workspaceBranch,
  workspaceRepoName: _workspaceRepoName,
  workspaceId,
  projectId,
  persistedMessages,
  persistedMessagesLoading,
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

// react-doctor-disable-next-line no-ref-current-in-render
isVisiblePaneRef.current = isVisiblePane

const conversationForBridge = useMemo(() => ({
    id: conversationId,
    backendConversationId: conversationId,
  }), [conversationId])

const chatSurface = useConversationChatSurface({
    conversation: conversationForBridge as unknown as Parameters<typeof useConversationChatSurface>[0]["conversation"],
    chatId: parentChatId,
    chatInstance: chat,
    resolverAgentId: provider,
    stopAgentId: backendAgentId,
    isActive,
    persistedMessages: persistedMessages as unknown[],
    persistedMessagesLoading,
    runtimeMessages: backendRuntimeMessages as unknown as Parameters<typeof useConversationChatSurface>[0]["runtimeMessages"],
    runtimeStatus: conversationRuntime?.status,
    source: "main",
    refreshDiff,
    onProviderChange,
    existingPrUrl,
  })

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
  } = chatSurface.upload

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
  } = chatSurface.textContext

  const {
    pastedTexts,
    addPastedText,
    addChatHistoryFile,
    removePastedText,
    clearPastedTexts,
    pastedTextsRef,
    setPastedTextsFromDraft,
  } = chatSurface.pasted

  const fileContentsRef = chatSurface.fileContentsRef
  const cacheFileContent = chatSurface.cacheFileContent
  const clearFileContents = () => fileContentsRef.current.clear()

  const shouldAutoScrollRef = chatSurface.shouldAutoScrollRef
  const isAutoScrollingRef = chatSurface.isAutoScrollingRef
  const isInitializingScrollRef = chatSurface.isInitializingScrollRef
  const scrollInitializedRef = chatSurface.scrollInitializedRef
  const hasUnapprovedPlanRef = chatSurface.hasUnapprovedPlanRef
  const chatContainerRef = chatSurface.chatContainerRef
  const chatContainerObserverRef = chatSurface.chatContainerObserverRef
  const contentWrapperRef = chatSurface.contentWrapperRef
  const prevScrollTopRef = chatSurface.prevScrollTopRef
  const saveScrollPosition = chatSurface.saveScrollPosition
  const isAtBottom = chatSurface.isAtBottom
  const handleScroll = chatSurface.handleScroll
  const scrollToBottom = chatSurface.scrollToBottom
const handlePlanApproval = chatSurface.handlePlanApproval
const handleApprovePlan = chatSurface.handleApprovePlan
const handleInputProviderChange = chatSurface.handleInputProviderChange
const handleContinueWithProvider = chatSurface.handleContinueWithProvider
const isContinuingRef = chatSurface.isContinuingRef
const chatInvocation = chatSurface.chatInvocation

const { sessionState, invocationQueue } = chatInvocation

const editorRef = chatSurface.editorRef

const fileInputRef = useRef<HTMLInputElement>(null)

const questionRef = chatSurface.questionRef

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
  }, [isActive, pendingMention, setPendingMention, editorRef])

const [isRollingBack, setIsRollingBack] = useAtom(isRollingBackAtom)

const utils = api.useUtils()

const conversationName = chatSurface.conversationName
const conversationNameRef = chatSurface.conversationNameRef
const renameConversationMutation = chatSurface.renameConversationMutation
const renameConversationMutationRef = chatSurface.renameConversationMutationRef
const handleRenameConversation = chatSurface.handleRenameConversation
const conversationMode = chatSurface.conversationMode
const setConversationMode = chatSurface.setConversationMode
const updateConversationModeMutation = chatSurface.updateConversationModeMutation
const handleModeChange = chatSurface.handleModeChange

  useConversationLifecycle(conversationId)
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

useEffect(() => {
  prevConversationIdRef.current = conversationId
}, [conversationId])

// react-doctor-disable-next-line no-ref-current-in-render
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

// react-doctor-disable-next-line no-ref-current-in-render
sendMessageRef.current = sendMessage

const stopRef = useRef(stop)

// react-doctor-disable-next-line no-ref-current-in-render
stopRef.current = stop

const isLocalStreaming = status === "streaming" || status === "submitted"

const isInitialPromptBusy =
    pendingInitialPrompt?.status === "pending" ||
    pendingInitialPrompt?.status === "dispatching" ||
    pendingInitialPrompt?.status === "running"

// A persisted runtime snapshot can outlive the durable chat history on a page
// refresh (hydration race). Until durable messages have loaded, do not treat
// a completed/error/idle runtime snapshot as an active turn. A genuinely
// streaming turn is still shown immediately.
const durableMessagesLoaded = persistedMessagesLoading !== true

const runtimeIsStreaming = conversationRuntime?.status === "streaming"
const sessionIsStreaming = sessionState?.isStreaming === true

const isBackendStreaming =
    isInitialPromptBusy ||
    runtimeIsStreaming ||
    (durableMessagesLoaded && sessionIsStreaming)

const isRuntimeStreaming =
    runtimeIsStreaming ||
    (durableMessagesLoaded && sessionIsStreaming)

const isStreaming = isLocalStreaming || isBackendStreaming


const streamingStatus = isLocalStreaming
    ? status
    : isStreaming
      ? "streaming"
      : status

const isStreamingRef = useRef(isStreaming)

// react-doctor-disable-next-line no-ref-current-in-render
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
    // Mark as manually aborted to prevent completion sound
    agentChatStore.setManuallyAborted(conversationId, true)

    // Always cancel the backend agent when an id is available: a locally
    // streaming turn still runs an agent on the backend, and relying on
    // session.status being "streaming" (which may lag) would skip the cancel.
    if (backendAgentId) {
      await trpcClient.ergatai.cancelPrompt
        .mutate({ agentId: backendAgentId })
        .catch((error) => {
          console.warn("[ActiveChat] Failed to cancel backend prompt:", error)
        })
    }

    // Unified stop: aborts the local AI SDK transport (if streaming) AND
    // notifies the backend to cancel the prompt. Replaces the previous
    // AI-SDK-only stop, which left the backend agent running.
    await chatInvocation.stop()
  // react-doctor-disable-next-line exhaustive-deps
  }, [backendAgentId, conversationId, isBackendStreaming, chatInvocation])

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
  }, [editorRef])

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
    formatAnswersAsText,
    handleQuestionsAnswer,
    handleQuestionsSkip,
    handleSubmitWithQuestionAnswer,
    submitWithQuestionAnswerCallback,
    isSubmittingQuestionAnswerRef,
  } = chatSurface

const detectedPrUrlRef = chatSurface.detectedPrUrlRef
const isCreatingPr = chatSurface.isCreatingPr
const setIsCreatingPr = chatSurface.setIsCreatingPr
const pendingAuthRetry = chatSurface.pendingAuthRetry
const setPendingAuthRetry = chatSurface.setPendingAuthRetry

const changedFilesForConversation = chatSurface.changedFiles
const recomputeChangedFiles = chatSurface.recomputeChangedFiles

const handleRollback = chatSurface.handleRollback

const handleForkFromMessage = chatSurface.handleForkFromMessage
const isForkingRef = { current: false }

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
      navigator.clipboard.writeText(textContent)
    }
  }

const hasUnapprovedPlan = chatSurface.hasUnapprovedPlan

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
    chatSurface,
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
