 
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useSetAtom } from "jotai"
import { type UIMessage } from "@ai-sdk/react"
import { ConversationStatusCard } from "../../agents"
import { useAgentsFileUpload } from "../../agents"
import { useChatAutoScroll } from "../../agents"
import { useTextContextSelection } from "../../agents"
import { usePastedTextFiles } from "../../agents"
import { useRollback } from "../../agents"
import { useForkConversation } from "../../agents"
import { ChatInputArea } from "../../agents"
import type { AgentsMentionsEditorHandle } from "../../agents"
import type { MessageTokenData } from "../../agents"
import type { ChatConversation } from "../lib/chat-contract-api"
import { ChatMessagesRenderer } from "../../agents"


import { useAgentRuntimeAgents } from "../../agents/public"
import { cn } from "@/lib/utils"
import { useStreamingStatusStore } from "../../agents"
import { syncMessagesWithStatusAtom } from "../../agents"
import { clearConversationRuntimeCaches } from "../../agents"
import { useChatInstance } from "../../agents"
import { useMainChatInvocation } from "@/features/agents"
import { clearLoading, loadingConversationsAtom, setLoading } from "../../agents"

interface SideChatProps {
  conversation: ChatConversation
  chatId: string
  agentId?: string | null
  isActive?: boolean
  /** True while the conversation snapshot is still loading. */
  isLoadingMessages?: boolean
  /** Live events from the backend runtime cache, used when attaching mid-turn. */
  externalMessages?: UIMessage[]
  runtimeStatus?: "idle" | "streaming" | "completed" | "error"
  runtimeConnectionStatus?: "connecting" | "connected" | "reconnecting" | "stopped"
}

/**
 * Side Chat - Uses shared useChatInstance hook
 *
 * Benefits of using useChatInstance:
 * 1. Unified message management (no duplicate code)
 * 2. Consistent behavior with main chat
 * 3. Automatic handling of message sync, queue, persistence
 * 4. Built-in agent-to-agent support via sendAgentMessage
 *
 * Phase 9 Migration:
 * - Introduced useSideChatInvocation bridge hook
 * - Uses new ConversationInvocationService for queue management
 * - Keeps useChatInstance for message rendering and streaming
 * - Progressive migration: can fall back to old behavior
 */
export function SideChat({
  conversation,
  chatId,
  agentId,
  isActive = true,
  isLoadingMessages = false,
  externalMessages = [],
  runtimeStatus,
  runtimeConnectionStatus,
}: SideChatProps) {
  const backendConversationId = conversation.backendConversationId
  const runtimeConversationId = backendConversationId ?? conversation.id

  const setLoadingConversations = useSetAtom(loadingConversationsAtom)

  const editorRef = useRef<AgentsMentionsEditorHandle>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const fileContentsRef = useRef<Map<string, string>>(new Map())

  // Rollback state
  const [isRollingBack, setIsRollingBack] = useState(false)

  // File upload
  const {
    images,
    files,
    handleAddAttachments,
    removeImage,
    removeFile,
    clearAll,
    isUploading,
  } = useAgentsFileUpload()

  // Text context selection
  const {
    textContexts,
    diffTextContexts,
    removeTextContext,
    removeDiffTextContext,
    clearTextContexts,
  } = useTextContextSelection()

  // Pasted text files
  const {
    pastedTexts,
    addPastedText,
    removePastedText,
  } = usePastedTextFiles(runtimeConversationId)

  // Shared rendering abstraction: reuse the same invocation controller as the
  // main chat, differing only in presentation/scroll. The local Chat instance
  // is created here and handed to the controller as `existingChat`.
  const chatInstance = useChatInstance({
    conversation,
    chatId,
    agentId,
    isActive,
  })

  // Type assertions needed because SideChat uses ChatConversation type which is
  // structurally compatible with but not nominally identical to the types expected
  // by useMainChatInvocation. This is a progressive migration artifact.
  const chatInvocation = useMainChatInvocation({
    conversation: conversation as any,
    chatId,
    agentId,
    isActive,
    persistedMessages: (conversation.messages ?? []) as any,
    runtimeMessages: externalMessages as any,
    existingChat: chatInstance as any,
    runtimeStatus,
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

  const isLocalStreaming =
    chatInstance.status === "streaming" || chatInstance.status === "submitted"
  const isBackendStreaming =
    runtimeStatus === "streaming" || sessionState?.isStreaming === true
  const isStreaming = isLocalStreaming || isBackendStreaming
  const status = isLocalStreaming
    ? chatInstance.status
    : isStreaming
      ? "streaming"
      : chatInstance.status

  // `messages` is now the unified RuntimeSessionStore view: persisted history,
  // the local Chat stream, and externally started agent-to-agent turns.
  const isRuntimeStreaming = runtimeStatus === "streaming"
  const displayMessages = messages

  // Propagate the (local or backend) streaming state into the shared store so
  // isolated message groups / rollback logic see side-chat turns as streaming,
  // including agent-to-agent turns and turns resumed after reopening.
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
      if (chatId) {
        setLoading(setLoadingConversations, runtimeConversationId, chatId)
      }
      return
    }
    if (status === "ready" || status === "error") {
      clearLoading(setLoadingConversations, runtimeConversationId)
    }
  }, [status, runtimeConversationId, chatId, setLoadingConversations])

  // ChatMessagesRenderer reads the optimized per-conversation message store,
  // not the messages prop. Seed it from backend-generated runtime turns so a
  // side chat attached mid-turn (or before persistence catches up) is visible.
  const syncExternalMessages = useSetAtom(syncMessagesWithStatusAtom)
  const externalRuntimeStatus = isRuntimeStreaming ? "streaming" : "ready"
  useLayoutEffect(() => {
    if (displayMessages.length === 0) {
      return
    }

    // Keep the per-conversation store in sync with the merged runtime view at
    // all times (including mid-stream), so ChatMessagesRenderer does not fall
    // back to the simplified text-only rendering while a turn is streaming.
    syncExternalMessages({
      messages: displayMessages,
      status: externalRuntimeStatus,
      conversationId: runtimeConversationId,
      updateGlobal: false,
    })
  }, [
    displayMessages,
    externalRuntimeStatus,
    runtimeConversationId,
    syncExternalMessages,
  ])

  const { containerRef, contentWrapperRef, scrollToBottom } = useChatAutoScroll({
    messages: displayMessages,
    status,
    isActive,
  })

  useEffect(() => {
    return () => {
      if (runtimeConversationId) {
        clearLoading(setLoadingConversations, runtimeConversationId)
      }
      clearConversationRuntimeCaches(runtimeConversationId)
    }
  }, [runtimeConversationId, setLoadingConversations])

  // Rollback handler - unified with main chat
  // Note: Side chat has simplified functionality - no diff view or draft restoration
  const { handleRollback } = useRollback({
    isRollingBack,
    setIsRollingBack,
    isStreaming,
    messages,
    setMessages,
    conversationId: runtimeConversationId,
    recomputeChangedFiles: () => {}, // No-op: Side chat has no diff view
    setImagesFromDraft: () => {}, // No-op: No draft restoration in side chat
    setTextContextsFromDraft: () => {}, // No-op: No draft restoration in side chat
    setDiffTextContextsFromDraft: () => {}, // No-op: No draft restoration in side chat
    setPastedTextsFromDraft: () => {}, // No-op: No draft restoration in side chat
    editorRef,
  })

  // Fork handler - unified with main chat
  const { handleForkFromMessage, isForkingRef: _isForkingRef } = useForkConversation({
    conversationId: runtimeConversationId,
    parentChatId: chatId,
    isStreaming,
    messages,
  })

  // Surface a visible state when the bound agent is not running
  const agentRuntimeStatus = useAgentRuntimeAgents(Boolean(agentId) && isActive)
  const isBoundAgentAlive = agentId
    ? (agentRuntimeStatus.agents.some(
        (agent) => agent.id === agentId && agent.isAlive,
      ) ?? true)
    : true

  // Send handler
  const handleSend = useCallback(() => {
    const inputValue = editorRef.current?.getValue() || ""
    if (!inputValue.trim() && images.length === 0 && files.length === 0) return

    const parts: UIMessage["parts"] = [
      { type: "text" as const, text: inputValue },
      ...images.map((image) => ({
        type: "data-image" as const,
        data: {
          filename: image.filename,
          url: image.url,
          base64Data: image.base64Data,
          mediaType: image.mediaType,
        },
      })),
      ...files.map((file) => ({
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

    // Type assertion needed because UIMessage parts format differs slightly from
    // the internal MessagePart type during the progressive migration.
    sendUserMessage(parts as any)

    editorRef.current?.clear()
    clearAll()
    clearTextContexts()
    scrollToBottom()
  }, [
    images,
    files,
    clearAll,
    clearTextContexts,
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
    stop()
  }, [stop, runtimeConversationId, setLoadingConversations])

  const handleCompact = useCallback(() => {
    if (isStreaming) return
    sendUserMessage([{ type: "text", text: "/compact" }] as any)
  }, [isStreaming, sendUserMessage])

  // Message token data (simplified)
  const messageTokenData = useMemo<MessageTokenData>(() => {
    return {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCostUsd: 0,
      contextWindow: 200000,
      messageCount: displayMessages.length,
    }
  }, [displayMessages.length])

  const cacheFileContent = useCallback((mentionId: string, content: string) => {
    fileContentsRef.current.set(mentionId, content)
  }, [])

  const sideChatLoadingState =
    (isLoadingMessages || isStreaming) && displayMessages.length === 0 ? (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-6">
        <div className="w-full max-w-[280px] space-y-3">
          <div className="ml-auto h-9 w-2/3 animate-pulse rounded-xl bg-muted/60" />
          <div className="h-16 w-full animate-pulse rounded-xl bg-muted/40" />
          <div className="ml-auto h-9 w-1/2 animate-pulse rounded-xl bg-muted/50" />
        </div>
        <p className="text-xs text-muted-foreground">Loading conversation…</p>
      </div>
    ) : undefined

  const sideChatEmptyState = (
    <div className="flex h-full flex-col items-center justify-center">
      <div className="mb-4 text-muted-foreground/60">
        <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          <path d="M9 10h6" />
          <path d="M12 7v6" />
        </svg>
      </div>
      <h3 className="text-base font-medium text-foreground mb-2">Side Chat</h3>
      <p className="text-sm text-muted-foreground text-center max-w-[240px]">
        Start a conversation with an agent by typing below.
      </p>
    </div>
  )

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-1 min-h-0 flex-col overflow-hidden">
        {runtimeConnectionStatus === "reconnecting" && (
          <div className="px-3 pt-2">
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
              Reconnecting to the live agent stream…
            </div>
          </div>
        )}
        {runtimeConnectionStatus !== "reconnecting" && runtimeStatus === "streaming" && (
          <div className="px-3 pt-2">
            <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-600 dark:text-emerald-400">
              Live streaming side-chat updates…
            </div>
          </div>
        )}
        <ChatMessagesRenderer
          // Type assertion needed because ChatMessagesRenderer expects a slightly different
          // message type during the progressive migration to the new conversation runtime.
          messages={displayMessages as any}
          status={status}
          conversationId={runtimeConversationId}
          chatId={chatId}
          isActive={isActive}
          containerRef={containerRef}
          contentWrapperRef={contentWrapperRef}
          className="w-full flex-1 overflow-x-hidden overflow-y-auto px-3 pt-3 select-text"
          contentClassName={cn(
            displayMessages.length === 0
              ? "flex h-full items-center justify-center"
              : "space-y-4 pb-4",
          )}
          loadingState={sideChatLoadingState}
          emptyState={sideChatEmptyState}
          onRollback={handleRollback}
          onFork={handleForkFromMessage}
        />

        <div className="w-full flex-shrink-0">
          {isStreaming && (
            <div className="px-3 -mb-6 relative z-10 shadow-sm shadow-background">
              <div className="mx-auto w-full max-w-full min-w-0">
                <ConversationStatusCard
                  chatId={chatId}
                  conversationId={runtimeConversationId}
                  isStreaming={isStreaming}
                  changedFiles={[]}
                  onStop={() => stop()}
                />
              </div>
            </div>
          )}

          {!isBoundAgentAlive && !isStreaming && (
            <div className="px-3 -mb-6 relative z-10 shadow-sm shadow-background">
              <div className="mx-auto w-full max-w-full min-w-0">
                <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
                  The bound agent is not running. New messages are queued but
                  won't be answered until the agent starts.
                </div>
              </div>
            </div>
          )}

          <ChatInputArea
            editorRef={editorRef}
            fileInputRef={fileInputRef}
            onSend={handleSend}
            onForceSend={handleForceSend}
            onStop={handleStop}
            onCompact={handleCompact}
            isStreaming={isStreaming}
            isCompacting={false}
            images={images}
            files={files}
            onAddAttachments={handleAddAttachments}
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
            conversationId={runtimeConversationId}
            parentChatId={chatId}
            provider={
              conversation.agent.id === "codex"
                ? "codex"
                : conversation.agent.id === "claude-code"
                  ? "claude-code"
                  : "opencode"
            }
            agentId={agentId}
            changedFiles={[]}
            isMobile={false}
            queueLength={invocationQueue.length}
            onSendFromQueue={handleSendFromQueue}
            firstQueueItemId={invocationQueue[0]?.id}
            isActive={isActive}
            isGroupMode={false}
          />
        </div>
      </div>
    </div>
  )
}
