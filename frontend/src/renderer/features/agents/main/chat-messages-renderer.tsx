/**
 * ChatMessagesRenderer - Shared conversation message surface.
 * Main chat and side chat both own their scroll controller, but use this
 * component as the single implementation of message rendering states.
 */

import { memo, useCallback } from "react"
import { useAtomValue } from "jotai"
import { userMessageIdsPerChatAtom } from "../stores/message-store"
import { IsolatedMessagesSection } from "./isolated-messages-section"
import { AgentUserMessageBubble } from "../ui/agent-user-message-bubble"
import { AgentToolCall } from "../ui/agent-tool-call"
import { AgentToolRegistry } from "../ui/agent-tool-registry"
import { MessageGroup } from "./message-group"
import type { UIMessage } from "@ai-sdk/react"
import { cn } from "@/lib/utils"
import { ChatMarkdownRenderer } from "../../../components/chat-markdown-renderer"

interface ChatMessagesRendererProps {
  messages: UIMessage<any>[]
  status: string
  conversationId: string
  chatId: string
  isActive?: boolean
  isEmpty?: boolean
  isMobile?: boolean
  sandboxSetupStatus?: "cloning" | "ready" | "error"
  sandboxSetupError?: string
  onRetrySetup?: () => void
  stickyTopClass?: string
  /** Refs are owned by the caller so main/side panes can use their own scroll policy. */
  containerRef?: React.Ref<HTMLDivElement>
  contentWrapperRef?: React.Ref<HTMLDivElement>
  className?: string
  contentClassName?: string
  /** Rendered above the message list (for example collaboration cards). */
  header?: React.ReactNode
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
  isMobile = false,
  sandboxSetupStatus = "ready",
  sandboxSetupError,
  onRetrySetup,
  stickyTopClass = "",
  containerRef,
  contentWrapperRef,
  className,
  contentClassName,
  header,
  emptyState,
  errorState,
  loadingState,
  onRollback,
  onFork,
}: ChatMessagesRendererProps) {
  const setContainerRef = useCallback(
    (node: HTMLDivElement | null) => {
      if (typeof containerRef === "function") {
        containerRef(node)
      } else if (containerRef) {
        containerRef.current = node
      }
    },
    [containerRef],
  )

  const setContentWrapperRef = useCallback(
    (node: HTMLDivElement | null) => {
      if (typeof contentWrapperRef === "function") {
        contentWrapperRef(node)
      } else if (contentWrapperRef) {
        contentWrapperRef.current = node
      }
    },
    [contentWrapperRef],
  )

  const storeUserMessageIds = useAtomValue(userMessageIdsPerChatAtom(conversationId))
  const containerClassName =
    className ?? "w-full flex-1 overflow-x-hidden overflow-y-auto px-3 pt-3 select-text"

  if (errorState) {
    return (
      <div
        ref={setContainerRef}
        className={containerClassName}
      >
        {errorState}
      </div>
    )
  }

  if (loadingState) {
    return (
      <div
        ref={setContainerRef}
        className={containerClassName}
      >
        {loadingState}
      </div>
    )
  }

  if (isEmpty || messages.length === 0) {
    return (
      <div
        ref={setContainerRef}
        className={containerClassName}
      >
        {emptyState === undefined ? (
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
        ) : emptyState}
      </div>
    )
  }

  // The optimized section groups only initiator messages (user/agent). If a
  // remount/cache-cleanup race leaves that store empty while message data is
  // already available, render the available messages directly instead of an
  // empty content pane.
  if (storeUserMessageIds.length === 0) {
    return (
      <div
        ref={setContainerRef}
        className={containerClassName}
      >
        <div className={cn("mx-auto w-full max-w-full min-w-0 space-y-4 pb-4", contentClassName)}>
          {messages.map((message) => {
            const role = message.role as string
            const text = message.parts
              ?.map((part: any) => (part?.type === "text" ? part.text || "" : ""))
              .join("\n") || ""

            // Only human user messages use the user bubble
            if (role === "user") {
              return (
                <AgentUserMessageBubble
                  key={message.id}
                  messageId={message.id}
                  textContent={text}
                />
              )
            }

            // Agent-initiated messages (agent-to-agent) use a distinct style
            if (role === "agent") {
              return (
                <div key={message.id} className="space-y-2 border-l-2 border-blue-300 pl-3">
                  <div className="text-xs font-medium text-blue-600 dark:text-blue-400">Agent Request</div>
                  {text ? <ChatMarkdownRenderer content={text} size="sm" /> : null}
                </div>
              )
            }

            // Assistant/system messages
            return (
              <div key={message.id} className="space-y-2">
                {text ? <ChatMarkdownRenderer content={text} size="sm" /> : null}
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  return (
    <div
      ref={setContainerRef}
      className={containerClassName}
    >
      <div
        ref={setContentWrapperRef}
        className={cn(
          "mx-auto w-full max-w-full min-w-0 space-y-4 pb-4",
          contentClassName,
        )}
      >
        {header}
        <IsolatedMessagesSection
          key={conversationId}
          conversationId={conversationId}
          chatId={chatId}
          isMobile={isMobile}
          sandboxSetupStatus={sandboxSetupStatus}
          sandboxSetupError={sandboxSetupError}
          onRetrySetup={onRetrySetup}
          stickyTopClass={stickyTopClass}
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
