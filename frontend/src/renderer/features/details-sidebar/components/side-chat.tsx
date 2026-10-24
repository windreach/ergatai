import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useSetAtom } from "jotai"
import { type UIMessage } from "@ai-sdk/react"
import { toast } from "sonner"
import { ConversationStatusCard } from "../../agents/ui/conversation-status-card"
import { useAgentsFileUpload } from "../../agents/hooks/use-agents-file-upload"
import { useChatAutoScroll } from "../../agents/hooks/use-chat-auto-scroll"
import { useTextContextSelection } from "../../agents/hooks/use-text-context-selection"
import { usePastedTextFiles } from "../../agents/hooks/use-pasted-text-files"
import { useRollback } from "../../agents/hooks/use-rollback"
import { useForkConversation } from "../../agents/hooks/use-fork-conversation"
import { ChatInputArea } from "../../agents/main/chat-input-area"
import type { AgentsMentionsEditorHandle } from "../../agents/mentions"
import type { MessageTokenData } from "../../agents/ui/agent-context-indicator"
import type { ChatConversation, ChatMessage } from "../lib/chat-contract-api"
import { ChatMessagesRenderer } from "../../agents/main/chat-messages-renderer"
import {
  CORE_AGENT_OPTIONS,
  type CoreAgentId,
} from "../../agents/lib/agent-contract-api"
import { useAgentRuntimeAgents } from "../../agents/lib/agent-runtime-status-store"
import { AgentUserMessageBubble } from "../../agents/ui"
import { cn } from "@/lib/utils"
import { trpc, trpcClient } from "@/lib/trpc"
import { useStreamingStatusStore } from "../../agents/stores/streaming-status-store"
import { syncMessagesWithStatusAtom } from "../../agents/stores/message-store"
import { clearConversationRuntimeCaches } from "../../agents/stores/conversation-runtime-cleanup"
import { useChatInstance } from "../../agents/hooks/use-chat-instance"

interface SideChatProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- messages type is dynamic from backend
  conversation: ChatConversation & { messages?: any[] }
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

  // Use shared Chat instance hook - eliminates duplicate code!
  const {
    chat,
    messages,
    sendMessage,
    sendAgentMessage,
    status,
    stop,
    setMessages,
    isStreaming,
    queue,
    handleSend: sendUserMessage,
    handleSendFromQueue,
  } = useChatInstance({
    conversation,
    chatId,
    agentId,
    isActive,
  })

  // Runtime cache covers turns started outside this mounted Chat instance.
  // While this local instance is streaming, its transport is already the live
  // source. For an externally started turn (especially agent-to-agent), the
  // runtime cache must be appended even when history has already loaded;
  // otherwise the existing history hides the live turn until completion.
  const isRuntimeStreaming = runtimeStatus === "streaming"
  // A durable request can be present in both persisted messages and the live
  // runtime snapshot. Runtime deltas don't have persisted IDs yet, so only
  // remove runtime messages whose exact backend message ID is already loaded.
  const persistedMessageIds = useMemo(
    () => new Set(messages.map((message) => message.id)),
    [messages],
  )
  const visibleExternalMessages = useMemo(
    () => externalMessages.filter((message) => !persistedMessageIds.has(message.id)),
    [externalMessages, persistedMessageIds],
  )
  const runtimeMessagesVisible =
    visibleExternalMessages.length > 0 &&
    !isStreaming &&
    (isRuntimeStreaming || messages.length === 0)

  // Memoize to prevent unnecessary re-renders when runtimeMessagesVisible is true
  const displayMessages = useMemo(() => {
    if (isStreaming) {
      return messages
    }
    if (runtimeMessagesVisible) {
      return [...messages, ...visibleExternalMessages]
    }
    return messages
  }, [isStreaming, messages, runtimeMessagesVisible, visibleExternalMessages])

  // ChatMessagesRenderer reads the optimized per-conversation message store,
  // not the messages prop. Seed it from backend-generated runtime turns so a
  // side chat attached mid-turn (or before persistence catches up) is visible.
  const syncExternalMessages = useSetAtom(syncMessagesWithStatusAtom)
  const externalRuntimeStatus = isRuntimeStreaming ? "streaming" : "ready"
  useLayoutEffect(() => {
    if (!runtimeMessagesVisible || visibleExternalMessages.length === 0) {
      return
    }

    syncExternalMessages({
      messages: displayMessages,
      status: externalRuntimeStatus,
      conversationId: runtimeConversationId,
      updateGlobal: false,
    })
  }, [
    displayMessages,
    visibleExternalMessages,
    externalRuntimeStatus,
    runtimeMessagesVisible,
    runtimeConversationId,
    syncExternalMessages,
  ])

  const { containerRef, contentWrapperRef, scrollToBottom } = useChatAutoScroll({
    messages: displayMessages,
    status,
    isActive,
  })

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
  const { handleForkFromMessage, isForkingRef } = useForkConversation({
    conversationId: runtimeConversationId,
    parentChatId: chatId,
    isStreaming,
    messages,
    utils: trpc.useUtils(),
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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- UIMessage generic requires type parameter
    const parts: UIMessage<any>["parts"] = [
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

    sendUserMessage(parts)

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
  ])

  const handleForceSend = useCallback(async () => {
    await stop()
    handleSend()
  }, [stop, handleSend])

  const handleStop = useCallback(async () => {
    stop()
  }, [stop])

  const handleCompact = useCallback(() => {
    console.log("Compact not implemented for side chat")
  }, [])

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
    isLoadingMessages && displayMessages.length === 0 ? (
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
        <ChatMessagesRenderer
          messages={displayMessages}
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
            provider={conversation.agent.id === "codex" ? "codex" : "claude-code"}
            changedFiles={[]}
            isMobile={false}
            queueLength={queue.length}
            onSendFromQueue={handleSendFromQueue}
            firstQueueItemId={queue[0]?.id}
            isActive={isActive}
            isGroupMode={false}
          />
        </div>
      </div>
    </div>
  )
}
