 
import { useCallback, useRef, useState } from "react"
import { type UIMessage } from "@ai-sdk/react"
import { ActiveChatDock } from "../../agents"
import { TextSelectionProvider, TextSelectionPopover, QuickCommentInput, useTextContextSelection, useQuickComment, useMessageQueueStore } from "../../agents"
import type { AgentsMentionsEditorHandle } from "../../agents"
import type { MessageTokenData } from "../../agents"
import type { ChatConversation } from "../lib/chat-contract-api"
import { ActiveChatMessages, useChatInstance } from "../../agents"
import { useAgentRuntimeAgents } from "../../agents/public"
import { useConversationChatSurface } from "@/features/agents"
import { ChatSurfaceShell } from "@/features/agents"

interface SideChatProps {
  conversation: ChatConversation
  chatId: string
  agentId?: string | null
  isActive?: boolean
  projectPath?: string | null
  repository?: string
  sandboxId?: string
  teamId?: string
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
// react-doctor-disable-next-line no-high-complexity-react-function
// react-doctor-disable-next-line no-giant-component
export function SideChat({
  conversation,
  chatId,
  agentId,
  isActive = true,
  isLoadingMessages = false,
  externalMessages = [],
  runtimeStatus,
  runtimeConnectionStatus,
  projectPath,
  repository,
  sandboxId,
  teamId,
}: SideChatProps) {
  const backendConversationId = conversation.backendConversationId
  const runtimeConversationId = backendConversationId ?? conversation.id

  // Shared rendering abstraction: reuse the same invocation controller as the
  // main chat. runtimeAgentId is the transport target.
  const runtimeAgentId = agentId

  const chatInstance = useChatInstance({
    conversation,
    chatId,
    agentId: runtimeAgentId,
    isActive,
  })

  const isRuntimeStreaming = runtimeStatus === "streaming"

  const surface = useConversationChatSurface({
    conversation,
    chatId,
    chatInstance,
    agentId: runtimeAgentId,
    isActive,
    persistedMessages: (conversation.messages ?? []) as any,
    persistedMessagesLoading: isLoadingMessages,
    runtimeMessages: externalMessages as any,
    runtimeStatus,
    projectPath,
    repository,
    sandboxId,
    teamId,
    source: "side",
  })

  const displayMessages = surface.messages
  const status = surface.status
  const isStreaming = surface.isStreaming
  const sessionState = surface.sessionState
  const invocationQueue = surface.invocationQueue
  const handleSend = surface.handleSend
  const handleSendFromQueue = surface.handleSendFromQueue
  const stop = surface.stop
  const handleStop = stop
  const handleForceSend = surface.handleForceSend
  const handleCompact = surface.handleCompact
  const sideChangedFiles = surface.changedFiles
  const recomputeChangedFiles = surface.recomputeChangedFiles
  const handleRollback = surface.handleRollback
  const handleForkFromMessage = surface.handleForkFromMessage
  const containerRef = surface.containerRef
  const chatContainerObserverRef = surface.chatContainerObserverRef
  const contentWrapperRef = surface.contentWrapperRef
  const scrollToBottom = surface.scrollToBottom
  const editorRef = surface.editorRef
  const fileInputRef = surface.fileInputRef
  const upload = surface.upload
  const textContext = surface.textContext
  const pasted = surface.pasted
  const cacheFileContent = surface.cacheFileContent
  const hasPermissionApproval = surface.hasPermissionApproval
  const setHasPermissionApproval = surface.setHasPermissionApproval
  const handleModeChange = surface.handleModeChange
  const questionRef = surface.questionRef
  const handleInputProviderChange = surface.handleInputProviderChange
  const handleContinueWithProvider = surface.handleContinueWithProvider
  const displayQuestions = surface.displayQuestions
  const handleQuestionsAnswer = surface.handleQuestionsAnswer
  const handleQuestionsSkip = surface.handleQuestionsSkip
  const inputHasContent = surface.inputHasContent
  const setInputHasContent = surface.setInputHasContent
  const submitWithQuestionAnswerCallback = surface.submitWithQuestionAnswerCallback
  const messageTokenData = surface.messageTokenData
  const provider = surface.provider

  const textContextSelection = useTextContextSelection()
  const addToQueue = useMessageQueueStore((s) => s.addToQueue)
  const isStreamingRef = surface.isStreamingRef
  const sendMessageRef = surface.sendMessageRef
  const {
    quickCommentState,
    handleQuickComment,
    handleQuickCommentSubmit,
    handleQuickCommentCancel,
  } = useQuickComment({
    conversationId: runtimeConversationId,
    isStreamingRef,
    addToQueue,
    sendMessageRef,
  })

  const handleFocusInput = useCallback(() => {
    editorRef.current?.focus()
  }, [editorRef])

  const addTextContext = useCallback(
    (text: string, source: any) => {
      textContextSelection.addTextContext(text, source)
    },
    [textContextSelection],
  )

  const {
    images,
    files,
    handleAddAttachments,
    handleAddFolder,
    removeImage,
    removeFile,
    clearAll,
    isUploading,
  } = upload

  const {
    textContexts,
    diffTextContexts,
    removeTextContext,
    removeDiffTextContext,
    clearTextContexts,
  } = textContext

  const {
    pastedTexts,
    addPastedText,
    removePastedText,
  } = pasted

  // Surface a visible state when the bound agent is not running
  const agentRuntimeStatus = useAgentRuntimeAgents(Boolean(runtimeAgentId) && isActive)
  const boundAgent = runtimeAgentId
    ? agentRuntimeStatus.agents.find((agent) => agent.id === runtimeAgentId)
    : undefined
  const isBoundAgentAlive = runtimeAgentId ? (boundAgent?.isAlive ?? true) : true
  const isBoundAgentSuspended = boundAgent?.status === "suspended"

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
    <TextSelectionProvider>
    <div className="flex h-full min-h-0 flex-col">
      {isActive && (
        <TextSelectionPopover
          onAddToContext={addTextContext as any}
          onQuickComment={handleQuickComment as any}
          onFocusInput={handleFocusInput}
        />
      )}
      {quickCommentState && (
        <QuickCommentInput
          selectedText={quickCommentState.selectedText}
          source={quickCommentState.source}
          rect={quickCommentState.rect}
          onSubmit={handleQuickCommentSubmit}
          onCancel={handleQuickCommentCancel}
        />
      )}
      <ChatSurfaceShell
        messagesSlot={
          <ActiveChatMessages
            messages={displayMessages as any}
            status={status}
            conversationId={runtimeConversationId}
            agentId={agentId}
            chatId={chatId}
            isActive={isActive}
            chatContainerRef={containerRef}
            chatContainerObserverRef={chatContainerObserverRef}
            contentWrapperRef={contentWrapperRef}
            implicitCollaborationTasks={[]}
            handleRollback={handleRollback}
            handleForkFromMessage={handleForkFromMessage}
            loadingState={sideChatLoadingState}
            emptyState={sideChatEmptyState}
          />
        }
        afterMessagesSlot={null}
        footerSlot={
          <div className="w-full flex-shrink-0">
            {!isBoundAgentAlive && !isStreaming && !isBoundAgentSuspended && (
              <div className="px-3 -mb-6 relative z-10 shadow-sm shadow-background">
                <div className="mx-auto w-full max-w-full min-w-0">
                  <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
                    The bound agent is not running. New messages are queued but
                    won't be answered until the agent starts.
                  </div>
                </div>
              </div>
            )}

            <ActiveChatDock
              isVisiblePane={isActive}
              parentChatId={chatId}
              conversationId={runtimeConversationId}
              setHasPermissionApproval={setHasPermissionApproval}
              hasPermissionApproval={hasPermissionApproval}
              displayQuestions={displayQuestions}
              questionRef={questionRef}
              handleQuestionsAnswer={handleQuestionsAnswer}
              handleQuestionsSkip={handleQuestionsSkip}
              inputHasContent={inputHasContent}
              queue={invocationQueue}
              handleRemoveFromQueue={() => {}}
              handleSendFromQueue={handleSendFromQueue}
              shouldShowStatusCard={isStreaming || sideChangedFiles.length > 0}
              shouldShowStackedCards={invocationQueue.length > 0 || isStreaming || sideChangedFiles.length > 0}
              isStreaming={isStreaming}
              isCompacting={false}
              changedFilesForConversation={sideChangedFiles}
              projectPath={projectPath ?? null}
              handleStop={handleStop}
              editorRef={editorRef}
              fileInputRef={fileInputRef}
              handleSend={handleSend}
              handleForceSend={handleForceSend}
              handleCompact={handleCompact}
              onCreateNewConversation={undefined}
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
              provider={provider as any}
              backendAgentId={agentId}
              teamId={teamId}
              repository={repository}
              sandboxId={sandboxId}
              isMobile={false}
              setInputHasContent={setInputHasContent}
              submitWithQuestionAnswerCallback={submitWithQuestionAnswerCallback}
              handleInputProviderChange={handleInputProviderChange}
              handleContinueWithProvider={handleContinueWithProvider}
              isActive={isActive}
              isGroupMode={false}
              handleGroupAgentsChange={undefined}
              chatContainerRef={containerRef}
              scrollToBottom={scrollToBottom}
              isSplitPane={false}
            />
          </div>
        }
      />
    </div>
    </TextSelectionProvider>
  )
}
