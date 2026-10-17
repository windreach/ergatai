/**
 * ChatMessagesRenderer - Message rendering component extracted from main chat
 * Reuses the full rendering capabilities of the main chat in the sidebar
 */

import { memo, useMemo } from "react"
import { useChatAutoScroll } from "../hooks/use-chat-auto-scroll"
import { IsolatedMessagesSection } from "./isolated-messages-section"
import { AgentUserMessageBubble } from "../ui/agent-user-message-bubble"
import { AgentToolCall } from "../ui/agent-tool-call"
import { AgentToolRegistry } from "../ui/agent-tool-registry"
import { MessageGroup } from "./active-chat"
import type { UIMessage } from "@ai-sdk/react"
import { cn } from "@/lib/utils"

interface ChatMessagesRendererProps {
  messages: UIMessage<any>[]
  status: string
  conversationId: string
  chatId: string
  isActive?: boolean
  isEmpty?: boolean
  emptyState?: React.ReactNode
  errorState?: React.ReactNode
  loadingState?: React.ReactNode
  // Functional props - unified with main chat
  onRollback?: (msg: UIMessage) => void
  onFork?: (messageId: string) => void
}

export const ChatMessagesRenderer = memo(function ChatMessagesRenderer({
  messages,
  status,
  conversationId,
  chatId,
  isActive = true,
  isEmpty = false,
  emptyState,
  errorState,
  loadingState,
  onRollback,
  onFork,
}: ChatMessagesRendererProps) {
  const { containerRef, contentWrapperRef } = useChatAutoScroll({
    messages,
    status,
    isActive,
  })

  if (errorState) {
    return (
      <div
        ref={containerRef}
        className="w-full flex-1 overflow-x-hidden overflow-y-auto px-3 pt-3 select-text"
      >
        {errorState}
      </div>
    )
  }

  if (loadingState) {
    return (
      <div
        ref={containerRef}
        className="w-full flex-1 overflow-x-hidden overflow-y-auto px-3 pt-3 select-text"
      >
        {loadingState}
      </div>
    )
  }

  if (isEmpty || messages.length === 0) {
    return (
      <div
        ref={containerRef}
        className="w-full flex-1 overflow-x-hidden overflow-y-auto px-3 pt-3 select-text"
      >
        {emptyState || (
          <div className="flex flex-col items-center justify-center">
            <div className="mb-4 text-muted-foreground/60">
              <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                <path d="M9 10h6" />
                <path d="M12 7v6" />
              </svg>
            </div>
            <h3 className="text-base font-medium text-foreground mb-2">Chat</h3>
            <p className="text-sm text-muted-foreground text-center max-w-[240px]">
              Start a conversation by typing below.
            </p>
          </div>
        )}
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      className="w-full flex-1 overflow-x-hidden overflow-y-auto px-3 pt-3 select-text"
    >
      <div
        ref={contentWrapperRef}
        className={cn(
          "mx-auto w-full max-w-full min-w-0 space-y-4 pb-4"
        )}
      >
        <IsolatedMessagesSection
          key={conversationId}
          conversationId={conversationId}
          chatId={chatId}
          isMobile={false}
          sandboxSetupStatus="ready"
          stickyTopClass=""
          UserBubbleComponent={AgentUserMessageBubble}
          ToolCallComponent={AgentToolCall}
          MessageGroupWrapper={MessageGroup}
          toolRegistry={AgentToolRegistry}
          onRollback={onRollback}
          onFork={onFork}
        />
      </div>
    </div>
  )
})
