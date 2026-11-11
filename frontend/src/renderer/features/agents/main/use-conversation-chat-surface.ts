"use client"

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import type { RefObject } from "react"
import { useSetAtom } from "jotai"
import type { UIMessage } from "@ai-sdk/react"
import { useChatInstance } from "../hooks/use-chat-instance"
import { useMainChatInvocation } from "../hooks/use-main-chat-invocation"
import { useChangedFilesTracking } from "../hooks/use-changed-files-tracking"
import { useMessageTokenData } from "../hooks/use-message-token-data"
import { useActiveChatConversationMeta } from "./use-active-chat-conversation-meta"
import { useRollback } from "../hooks/use-rollback"
import { useForkConversation } from "../hooks/use-fork-conversation"
import { useScrollManagement } from "../hooks/use-scroll-management"
import { useAgentsFileUpload } from "../hooks/use-agents-file-upload"
import { useAtom } from "jotai"
import { pendingMentionAtom, pendingBuildPlanConversationIdAtom, pendingInitialPromptAtomFamily } from "../atoms"
import { useTextContextSelection } from "../hooks/use-text-context-selection"
import { usePastedTextFiles } from "../hooks/use-pasted-text-files"
import { useQuestionHandling } from "../hooks/use-question-handling"
import { useQuestionAnswers } from "../hooks/use-question-answers"
import { usePlanApproval } from "../hooks/use-plan-approval"
import { useProviderSelection } from "../hooks/use-provider-selection"
import { usePrDetection } from "../hooks/use-pr-detection"
import { useUnapprovedPlanDetection } from "../hooks/use-unapproved-plan-detection"
import { usePendingActions } from "../hooks/use-pending-actions"
import { usePendingAuthRetry } from "../hooks/use-pending-auth-retry"
import { agentChatStore } from "../stores/agent-chat-store"
import { clearConversationDraft } from "../lib/drafts"
type Attachments = {
  images: any
  files: any
  handleAddAttachments: any
  handleAddFolder: any
  removeImage: any
  removeFile: any
  clearAll: any
  isUploading: any
  setImagesFromDraft: any
  setFilesFromDraft: any
  textContexts: any
  diffTextContexts: any
  addTextContextOriginal: any
  addDiffTextContext: any
  removeTextContext: any
  removeDiffTextContext: any
  clearTextContexts: any
  clearDiffTextContexts: any
  textContextsRef: any
  diffTextContextsRef: any
  setTextContextsFromDraft: any
  setDiffTextContextsFromDraft: any
  pastedTexts: any
  addPastedText: any
  addChatHistoryFile: any
  removePastedText: any
  clearPastedTexts: any
  pastedTextsRef: any
  setPastedTextsFromDraft: any
  fileContentsRef: any
  cacheFileContent: any
}
import { useStreamingStatusStore } from "../stores/streaming-status-store"
import { syncMessagesWithStatusAtom } from "../stores/message-store"
import { clearLoading, loadingConversationsAtom, setLoading } from "../atoms"
import { clearConversationRuntimeCaches } from "../stores/conversation-runtime-cleanup"
import type { ChatConversation } from "@/features/details-sidebar"
import type { AgentsMentionsEditorHandle } from "../mentions"
import { trpcClient } from "../../../lib/trpc"
import { api } from "../../../lib/api-adapter"

/**
 * Shared chat surface controller used by both main and side conversations.
 *
 * This hook centralizes the common runtime wiring (chat instance, invocation,
 * changed-files tracking, scroll, rollback/fork, composer state) so that main
 * and side chats consume one implementation instead of duplicating it.
 */
export function useConversationChatSurface({
  conversation,
  chatId,
  chatInstance,
  agentId,
  resolverAgentId,
  stopAgentId,
  isActive = true,
  persistedMessages = [],
  persistedMessagesLoading = false,
  runtimeMessages = [],
  runtimeStatus,
  projectPath,
  repository,
  sandboxId,
  teamId,
  source = "side",
  refreshDiff,
  onProviderChange,
  existingPrUrl,
  draftRecovery,
  attachments,
}: {
  conversation: ChatConversation
  chatId: string
  /** Existing chat instance (main chat passes its factory chat; side chat passes useChatInstance result). */
  chatInstance: any
  agentId?: string | null
  /** Invocation target agent id. Defaults to conversation.agent.id ?? agentId. */
  resolverAgentId?: string | null
  /** Backend agent id used for cancel on stop. Defaults to agentId. */
  stopAgentId?: string | null
  isActive?: boolean
  persistedMessages?: unknown[]
  persistedMessagesLoading?: boolean
  runtimeMessages?: UIMessage[]
  runtimeStatus?: "idle" | "streaming" | "completed" | "error"
  projectPath?: string | null
  repository?: string
  sandboxId?: string
  teamId?: string
  source?: "main" | "side"
  refreshDiff?: () => void
  onProviderChange?: (conversationId: string, provider: "claude-code" | "codex") => void
  existingPrUrl?: string | null
  /** Optional draft-recovery setters. When provided, rollback restores drafts; otherwise no-op. */
  draftRecovery?: {
    setImagesFromDraft: (images: any[]) => void
    setFilesFromDraft: (files: any[]) => void
    setTextContextsFromDraft: (contexts: any[]) => void
    setDiffTextContextsFromDraft: (contexts: any[]) => void
    setPastedTextsFromDraft: (texts: any[]) => void
    clearAll: () => void
    clearTextContexts: () => void
  }
  /** Optional shared attachments instance (avoids duplicate hook state). */
  attachments?: Attachments
}) {
  const backendConversationId = conversation.backendConversationId
  const runtimeConversationId = backendConversationId ?? conversation.id
  const provider =
    conversation.agent?.id === "codex"
      ? "codex"
      : conversation.agent?.id === "claude-code"
        ? "claude-code"
        : "opencode"

  const [pendingMention, setPendingMention] = useAtom(pendingMentionAtom)
  const [pendingInitialPrompt, setPendingInitialPrompt] = useAtom(
    pendingInitialPromptAtomFamily(runtimeConversationId),
  )

  const setLoadingConversations = useSetAtom(loadingConversationsAtom)

  const editorRef = useRef<AgentsMentionsEditorHandle>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!isActive || !pendingMention) return
    editorRef.current?.insertMention(pendingMention)
    editorRef.current?.focus()
    setPendingMention(null)
  }, [isActive, pendingMention, setPendingMention])
  const internalFileContentsRef = useRef<Map<string, string>>(new Map())
  const fileContentsRef = attachments ? attachments.fileContentsRef : internalFileContentsRef

  const [isRollingBack, setIsRollingBack] = useState(false)
  const [hasPermissionApproval, setHasPermissionApproval] = useState(false)

  const internalUpload = useAgentsFileUpload()
  const internalTextContext = useTextContextSelection()
  const internalPasted = usePastedTextFiles(runtimeConversationId)

  // Prefer a shared attachments instance when provided (avoids duplicate state).
  const upload = attachments
    ? {
        images: attachments.images,
        files: attachments.files,
        handleAddAttachments: attachments.handleAddAttachments,
        handleAddFolder: attachments.handleAddFolder,
        removeImage: attachments.removeImage,
        removeFile: attachments.removeFile,
        clearAll: attachments.clearAll,
        isUploading: attachments.isUploading,
        setImagesFromDraft: attachments.setImagesFromDraft,
        setFilesFromDraft: attachments.setFilesFromDraft,
      }
    : internalUpload
  const textContext = attachments
    ? {
        textContexts: attachments.textContexts,
        diffTextContexts: attachments.diffTextContexts,
        addTextContext: attachments.addTextContextOriginal,
        addDiffTextContext: attachments.addDiffTextContext,
        removeTextContext: attachments.removeTextContext,
        removeDiffTextContext: attachments.removeDiffTextContext,
        clearTextContexts: attachments.clearTextContexts,
        clearDiffTextContexts: attachments.clearDiffTextContexts,
        textContextsRef: attachments.textContextsRef,
        diffTextContextsRef: attachments.diffTextContextsRef,
        setTextContextsFromDraft: attachments.setTextContextsFromDraft,
        setDiffTextContextsFromDraft: attachments.setDiffTextContextsFromDraft,
      }
    : internalTextContext
  const pasted = attachments
    ? {
        pastedTexts: attachments.pastedTexts,
        addPastedText: attachments.addPastedText,
        addChatHistoryFile: attachments.addChatHistoryFile,
        removePastedText: attachments.removePastedText,
        clearPastedTexts: attachments.clearPastedTexts,
        pastedTextsRef: attachments.pastedTextsRef,
        setPastedTextsFromDraft: attachments.setPastedTextsFromDraft,
      }
    : internalPasted

  const invocationAgentId = resolverAgentId ?? conversation.agent?.id ?? agentId ?? null

  const chatInvocation = useMainChatInvocation({
    conversation: conversation as any,
    chatId,
    resolverAgentId: invocationAgentId,
    stopAgentId: stopAgentId ?? agentId ?? null,
    isActive,
    persistedMessages: persistedMessages as any,
    persistedMessagesLoading,
    runtimeMessages: runtimeMessages as any,
    existingChat: chatInstance as any,
    runtimeStatus: runtimeStatus as string | undefined,
    source,
  })

  const {
    messages,
    handleSend: sendUserMessage,
    handleSendFromQueue,
    stop: stopInvocation,
    sessionState,
    invocationQueue,
  } = chatInvocation

  const setMessages = chatInstance.setMessages
  const stop = stopInvocation

  const utils = api.useUtils()
  const conversationMeta = useActiveChatConversationMeta({
    conversationId: runtimeConversationId,
    parentChatId: chatId,
    utils,
  })
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
  } = conversationMeta

  const isLocalStreaming =
    chatInstance.status === "streaming" || chatInstance.status === "submitted"
  const isInitialPromptBusy =
    pendingInitialPrompt?.status === "pending" ||
    pendingInitialPrompt?.status === "dispatching" ||
    pendingInitialPrompt?.status === "running"

  const isBackendStreaming =
    isInitialPromptBusy ||
    runtimeStatus === "streaming" ||
    (persistedMessagesLoading !== true && sessionState?.isStreaming === true)
  const isStreaming = isLocalStreaming || isBackendStreaming

  const {
    isCreatingPr,
    setIsCreatingPr,
    pendingAuthRetry,
    setPendingAuthRetry,
  } = usePendingActions({
    conversationId: runtimeConversationId,
    isStreaming,
    sendMessage: sendUserMessage as any,
  })

  usePendingAuthRetry({
    pendingAuthRetry,
    conversationId: runtimeConversationId,
    provider: (provider === "opencode" ? "claude-code" : provider) as "claude-code" | "codex",
    isStreaming,
    sendMessage: sendUserMessage as any,
    setPendingAuthRetry,
  })

  const {
    handleInputProviderChange,
    handleContinueWithProvider,
    isContinuingRef,
  } = useProviderSelection({
    conversationId: runtimeConversationId,
    parentChatId: chatId,
    conversationMode,
    isStreaming,
    messages: messages as any,
    onProviderChange: onProviderChange,
    conversationNameRef,
  })

  const questionRef = useRef<any>(null)
  const sendMessageRef = useRef<any>(null)
  const stopRef = useRef<any>(null)
  const isStreamingRef = useRef(isStreaming)
  isStreamingRef.current = isStreaming

  const {
    pendingQuestions,
    expiredQuestions,
    displayQuestions,
    isQuestionExpired,
    inputHasContent,
    setInputHasContent,
    lastAssistantMessage,
    messageTokenData: questionMessageTokenData,
    setPendingQuestionsMap,
    setExpiredQuestionsMap,
    recentlyStoppedStreamRef,
  } = useQuestionHandling({
    conversationId: runtimeConversationId,
    isStreaming,
    messages: messages as any,
    provider,
  })

  // Keep refs in sync for question answers
  sendMessageRef.current = sendUserMessage
  stopRef.current = stop

  const clearPendingQuestionCallback = useCallback(() => {
    setPendingQuestionsMap((current: Map<string, any>) => {
      if (current.has(runtimeConversationId)) {
        const newMap = new Map(current)
        newMap.delete(runtimeConversationId)
        return newMap
      }
      return current
    })
    setExpiredQuestionsMap((current: Map<string, any>) => {
      if (current.has(runtimeConversationId)) {
        const newMap = new Map(current)
        newMap.delete(runtimeConversationId)
        return newMap
      }
      return current
    })
  }, [runtimeConversationId, setPendingQuestionsMap, setExpiredQuestionsMap])

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
    conversationId: runtimeConversationId,
    editorRef,
    questionRef,
    clearPendingQuestionCallback: () => {
      setPendingQuestionsMap((current: Map<string, any>) => {
        if (current.has(runtimeConversationId)) {
          const newMap = new Map(current)
          newMap.delete(runtimeConversationId)
          return newMap
        }
        return current
      })
    },
    clearInputAndDraft: () => {
      editorRef.current?.clear()
      if (chatId) {
        clearConversationDraft(chatId, runtimeConversationId)
      }
    },
    sendUserMessage: async (text: string) => {
      shouldAutoScrollRef.current = true
      await sendMessageRef.current?.({
        role: "user",
        parts: [{ type: "text", text }],
      })
    },
    isStreamingRef,
    stopRef,
    agentChatStore,
  })

  const { changedFiles, recomputeChangedFiles } = useChangedFilesTracking(
    messages as any,
    runtimeConversationId,
    isStreaming,
    chatId,
  )

  const status = isLocalStreaming
    ? chatInstance.status
    : isStreaming
      ? "streaming"
      : chatInstance.status

  const setStreamingStatus = useStreamingStatusStore((store) => store.setStatus)
  useEffect(() => {
    if (status === "streaming" || status === "submitted") {
      setStreamingStatus(runtimeConversationId, status as "streaming" | "submitted")
    } else {
      setStreamingStatus(runtimeConversationId, "ready")
    }
  }, [status, runtimeConversationId, setStreamingStatus])

  useEffect(() => {
    if (!runtimeConversationId) return
    if (status === "streaming" || status === "submitted") {
      if (chatId) setLoading(setLoadingConversations, runtimeConversationId, chatId)
      return
    }
    if (status === "ready" || status === "error") {
      clearLoading(setLoadingConversations, runtimeConversationId)
    }
  }, [status, runtimeConversationId, chatId, setLoadingConversations])

  const syncExternalMessages = useSetAtom(syncMessagesWithStatusAtom)
  const externalRuntimeStatus = runtimeStatus === "streaming" ? "streaming" : "ready"
  useLayoutEffect(() => {
    if ((messages as any[]).length === 0) return
    syncExternalMessages({
      messages,
      status: externalRuntimeStatus,
      conversationId: runtimeConversationId,
      updateGlobal: false,
    })
  }, [messages, externalRuntimeStatus, runtimeConversationId, syncExternalMessages])

  const isVisiblePaneRef = useRef(isActive)
  // react-doctor-disable-next-line no-ref-current-in-render
  isVisiblePaneRef.current = isActive

  const scrollManagement = useScrollManagement({
    conversationId: runtimeConversationId,
    isVisiblePane: isActive,
    isVisiblePaneRef,
  })
  const {
    shouldAutoScrollRef,
    isAutoScrollingRef,
    isInitializingScrollRef,
    scrollInitializedRef,
    hasUnapprovedPlanRef,
    chatContainerRef: _chatContainerRef,
    chatContainerObserverRef,
    contentWrapperRef,
    prevScrollTopRef,
    saveScrollPosition,
    isAtBottom,
    handleScroll,
    scrollToBottom,
  } = scrollManagement
  const containerRef = _chatContainerRef as RefObject<HTMLDivElement | null>
  const chatContainerRef = _chatContainerRef as RefObject<HTMLElement | null>

  const { detectedPrUrlRef } = usePrDetection({
    messages: messages as any,
    isStreaming,
    parentChatId: chatId,
    existingPrUrl: existingPrUrl ?? null,
    utils,
  })

  const { handlePlanApproval, handleApprovePlan } = usePlanApproval({
    conversationId: runtimeConversationId,
    setConversationMode,
    scrollToBottom,
    updateConversationModeMutation,
    sendMessageRef,
  })

  const [pendingBuildPlanConversationId, setPendingBuildPlanConversationId] = useAtom(
    pendingBuildPlanConversationIdAtom,
  )

  useEffect(() => {
    if (pendingBuildPlanConversationId === runtimeConversationId && isActive) {
      setPendingBuildPlanConversationId(null)
      handleApprovePlan()
    }
  }, [pendingBuildPlanConversationId, runtimeConversationId, isActive, setPendingBuildPlanConversationId, handleApprovePlan])

  const { hasUnapprovedPlan } = useUnapprovedPlanDetection({
    messages: messages as any,
    conversationMode,
    conversationId: runtimeConversationId,
    parentChatId: chatId,
    isActive,
    isStreaming,
    hasUnapprovedPlanRef,
    handleApprovePlan,
  })

  useEffect(() => {
    return () => {
      if (runtimeConversationId) clearLoading(setLoadingConversations, runtimeConversationId)
      clearConversationRuntimeCaches(runtimeConversationId)
    }
  }, [runtimeConversationId, setLoadingConversations])

  const { handleRollback } = useRollback({
    isRollingBack,
    setIsRollingBack,
    isStreaming,
    messages: messages as any,
    setMessages: setMessages as any,
    conversationId: runtimeConversationId,
    recomputeChangedFiles,
    setImagesFromDraft: draftRecovery?.setImagesFromDraft ?? upload.setImagesFromDraft ?? (() => {}),
    setTextContextsFromDraft: draftRecovery?.setTextContextsFromDraft ?? textContext.setTextContextsFromDraft ?? (() => {}),
    setDiffTextContextsFromDraft: draftRecovery?.setDiffTextContextsFromDraft ?? textContext.setDiffTextContextsFromDraft ?? (() => {}),
    setPastedTextsFromDraft: draftRecovery?.setPastedTextsFromDraft ?? pasted.setPastedTextsFromDraft ?? (() => {}),
    refreshDiff,
    editorRef,
  })

  const { handleForkFromMessage } = useForkConversation({
    conversationId: runtimeConversationId,
    parentChatId: chatId,
    isStreaming,
    messages: messages as any,
  })

  const handleSend = useCallback(() => {
    const inputValue = editorRef.current?.getValue() || ""
    if (!inputValue.trim() && upload.images.length === 0 && upload.files.length === 0) return

    const parts: UIMessage["parts"] = [
      { type: "text" as const, text: inputValue },
      ...upload.images.map((image: any) => ({
        type: "data-image" as const,
        data: {
          filename: image.filename,
          url: image.url,
          base64Data: image.base64Data,
          mediaType: image.mediaType,
        },
      })),
      ...upload.files.map((file: any) => ({
        type: "data-file" as const,
        data: {
          filename: file.filename,
          url: file.url,
          size: file.size,
          mediaType: file.type,
        },
      })),
    ]

    if (runtimeConversationId && chatId) {
      setLoading(setLoadingConversations, runtimeConversationId, chatId)
    }

    sendUserMessage(parts as any)
    editorRef.current?.clear()
    upload.clearAll()
    textContext.clearTextContexts()
    scrollToBottom()
  }, [
    upload,
    textContext,
    scrollToBottom,
    sendUserMessage,
    runtimeConversationId,
    chatId,
    setLoadingConversations,
  ])

  const handleForceSend = useCallback(async () => {
    if (runtimeConversationId && chatId) {
      clearLoading(setLoadingConversations, runtimeConversationId)
      setLoading(setLoadingConversations, runtimeConversationId, chatId)
    }
    await stop()
    handleSend()
  }, [stop, handleSend, runtimeConversationId, chatId, setLoadingConversations])

  const handleStop = useCallback(async () => {
    if (runtimeConversationId) {
      clearLoading(setLoadingConversations, runtimeConversationId)
    }
    if (agentId) {
      await trpcClient.ergatai.cancelPrompt
        .mutate({ agentId })
        .catch((error) => {
          console.warn("[ConversationChatSurface] Failed to cancel backend prompt:", error)
        })
    }
    await stop()
  }, [stop, runtimeConversationId, setLoadingConversations, agentId])

  const handleCompact = useCallback(() => {
    if (isStreaming) return
    sendUserMessage([{ type: "text", text: "/compact" }] as any)
  }, [isStreaming, sendUserMessage])

  const messageTokenData = useMessageTokenData(messages as any, provider, sessionState as any)

  const cacheFileContent = attachments
    ? attachments.cacheFileContent
    : useCallback((mentionId: string, content: string) => {
        fileContentsRef.current.set(mentionId, content)
      }, [])

  return {
    // chat instance
    chatInstance,
    // invocation
    chatInvocation,
    messages,
    status,
    isStreaming,
    sessionState,
    invocationQueue,
    handleSend,
    handleSendFromQueue: handleSendFromQueue,
    stop: handleStop,
    handleForceSend,
    handleCompact,
    // changed files
    changedFiles,
    recomputeChangedFiles,
    // rollback/fork
    handleRollback,
    handleForkFromMessage,
    // scroll
    containerRef,
    contentWrapperRef,
    scrollToBottom,
    shouldAutoScrollRef,
    isAutoScrollingRef,
    isInitializingScrollRef,
    scrollInitializedRef,
    hasUnapprovedPlanRef,
    chatContainerRef: containerRef,
    chatContainerObserverRef,
    prevScrollTopRef,
    saveScrollPosition,
    isAtBottom,
    handleScroll,
    // composer
    editorRef,
    fileInputRef,
    upload,
    textContext,
    pasted,
    cacheFileContent,
    fileContentsRef,
    hasPermissionApproval,
    setHasPermissionApproval,
    // meta
    conversationName,
    conversationNameRef,
    renameConversationMutation,
    renameConversationMutationRef,
    handleRenameConversation,
    conversationMode,
    setConversationMode,
    updateConversationModeMutation,
    handleModeChange,
    messageTokenData,
    provider,
    runtimeConversationId,
    handlePlanApproval,
    handleApprovePlan,
    handleInputProviderChange,
    handleContinueWithProvider,
    isContinuingRef,
    detectedPrUrlRef,
    hasUnapprovedPlan,
    isCreatingPr,
    setIsCreatingPr,
    pendingAuthRetry,
    setPendingAuthRetry,
    isLocalStreaming,
    isBackendStreaming,
    // questions
    questionRef,
    isStreamingRef,
    sendMessageRef,
    pendingQuestions,
    expiredQuestions,
    displayQuestions,
    isQuestionExpired,
    inputHasContent,
    setInputHasContent,
    lastAssistantMessage,
    setPendingQuestionsMap,
    setExpiredQuestionsMap,
    recentlyStoppedStreamRef,
    formatAnswersAsText,
    handleQuestionsAnswer,
    handleQuestionsSkip,
    handleSubmitWithQuestionAnswer,
    submitWithQuestionAnswerCallback,
    isSubmittingQuestionAnswerRef,
  }
}
