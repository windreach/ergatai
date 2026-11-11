"use client"

import { memo } from "react"
import type { RefObject } from "react"
import type { UIMessage } from "@ai-sdk/react"
import { cn } from "../../../lib/utils"
import { ChatMessagesRenderer } from "./chat-messages-renderer"
import { useConversationHistoryImport } from "../hooks/use-conversation-history-import"
// import { ImplicitCollaborationTaskCards } from "../collaboration/implicit-collaboration-task-cards"
// import { CollaborationSessionEventCards } from "../collaboration/collaboration-session-event-cards"
import type { ImplicitCollaborationTask } from "../collaboration/implicit-collaboration"

type CollaborationSession = ReturnType<
  typeof import("../collaboration/collaboration-session-runtime").useCollaborationSession
>

interface ActiveChatMessagesProps {
  messages: UIMessage<unknown>[]
  status: string
  conversationId: string
  agentId?: string | null
  chatId: string
  isActive: boolean
  isMobile?: boolean
  sandboxSetupStatus?: "cloning" | "ready" | "error"
  sandboxSetupError?: string
  onRetrySetup?: () => void
  stickyTopClass?: string
  chatContainerRef: RefObject<HTMLElement | null>
  chatContainerObserverRef?: RefObject<ResizeObserver | null>
  contentWrapperRef?: RefObject<HTMLDivElement | null>
  implicitCollaborationTasks?: ImplicitCollaborationTask[]
  collaborationSession?: CollaborationSession
  handleRollback: (msg: UIMessage<unknown>) => void
  handleForkFromMessage: (messageId: string) => void
  /** Optional loading/empty states forwarded to the underlying renderer. */
  loadingState?: React.ReactNode
  emptyState?: React.ReactNode
}

export const ActiveChatMessages = memo(function ActiveChatMessages({
  messages,
  status,
  conversationId,
  agentId,
  chatId,
  isActive,
  isMobile = false,
  sandboxSetupStatus = "ready",
  sandboxSetupError,
  onRetrySetup,
  stickyTopClass = "",
  chatContainerRef,
  chatContainerObserverRef,
  contentWrapperRef,
  implicitCollaborationTasks = [],
  collaborationSession,
  handleRollback,
  handleForkFromMessage,
  loadingState,
  emptyState,
}: ActiveChatMessagesProps) {

  const { importBanner } = useConversationHistoryImport({
    conversationId,
    agentId,
    containerRef: chatContainerRef,
  })

  return (
    <ChatMessagesRenderer
      messages={messages}
      status={status}
      conversationId={conversationId}
      chatId={chatId}
      isActive={isActive}
      isMobile={isMobile}
      sandboxSetupStatus={sandboxSetupStatus}
      sandboxSetupError={sandboxSetupError}
      onRetrySetup={onRetrySetup}
      stickyTopClass={stickyTopClass}
      containerRef={(el) => {
        chatContainerRef.current = el
        const observerRef = chatContainerObserverRef
        if (observerRef?.current) {
          observerRef.current.disconnect()
          observerRef.current = null
        }
        if (el && observerRef) {
          const parent = el.parentElement
          const observer = new ResizeObserver((entries) => {
            const { height, width } = entries[0]?.contentRect ?? {
              height: 0,
              width: 0,
            }
            el.style.setProperty("--chat-container-height", `${height}px`)
            el.style.setProperty("--chat-container-width", `${width}px`)
            parent?.style.setProperty("--chat-container-height", `${height}px`)
            parent?.style.setProperty("--chat-container-width", `${width}px`)
          })
          observer.observe(el)
          observerRef.current = observer
        }
      }}
      contentWrapperRef={contentWrapperRef}
      className="flex-1 overflow-y-auto w-full relative allow-text-selection outline-none"
      contentClassName={cn("px-2 mx-auto -mb-4 max-w-2xl pb-8")}
      header={
        <>
          {importBanner}
          {/* Collaboration cards are intentionally not rendered in the chat surface
              (they belong to the side rail / monitoring view). Kept commented
              out as legacy wiring. */}
          {/* {implicitCollaborationTasks.length > 0 && (
            <ImplicitCollaborationTaskCards tasks={implicitCollaborationTasks} />
          )}
          {collaborationSession?.events?.length ? (
            <CollaborationSessionEventCards events={collaborationSession.events} />
          ) : null} */}
        </>
      }
      loadingState={loadingState}
      emptyState={emptyState === undefined ? null : emptyState}
      onRollback={handleRollback}
      onFork={handleForkFromMessage}
    />
  )
})