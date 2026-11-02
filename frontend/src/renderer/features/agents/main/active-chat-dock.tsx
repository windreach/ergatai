"use client"

import { PermissionApprovalPanel } from "../../../components/dialogs/permission-approval-dialog"
import { AgentUserQuestion } from "../ui/agent-user-question"
import { AgentQueueIndicator } from "../ui/agent-queue-indicator"
import { ConversationStatusCard } from "../ui/conversation-status-card"
import { ChatInputArea } from "./chat-input-area"
import { ScrollToBottomButton } from "./active-chat-ui"

export function ActiveChatDock(props: any) {
  const {
    isVisiblePane,
    parentChatId,
    conversationId,
    setHasPermissionApproval,
    hasPermissionApproval,
    displayQuestions,
    questionRef,
    handleQuestionsAnswer,
    handleQuestionsSkip,
    inputHasContent,
    queue,
    handleRemoveFromQueue,
    handleSendFromQueue,
    shouldShowStatusCard,
    shouldShowStackedCards,
    isStreaming,
    isCompacting,
    changedFilesForConversation,
    projectPath,
    handleStop,
    editorRef,
    fileInputRef,
    handleSend,
    handleForceSend,
    handleCompact,
    onCreateNewConversation,
    handleModeChange,
    images,
    files,
    handleAddAttachments,
    handleAddFolder,
    removeImage,
    removeFile,
    isUploading,
    textContexts,
    removeTextContext,
    diffTextContexts,
    removeDiffTextContext,
    pastedTexts,
    addPastedText,
    removePastedText,
    cacheFileContent,
    messageTokenData,
    provider,
    backendAgentId,
    teamId,
    repository,
    sandboxId,
    isMobile,
    setInputHasContent,
    submitWithQuestionAnswerCallback,
    handleInputProviderChange,
    handleContinueWithProvider,
    isActive,
    isGroupMode,
    handleGroupAgentsChange,
    chatContainerRef,
    scrollToBottom,
    isSplitPane,
  } = props

  return (
    <>
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
        agentId={backendAgentId}
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
    </>
  )
}
