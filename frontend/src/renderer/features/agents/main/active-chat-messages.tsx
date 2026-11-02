"use client"

import { memo } from "react"
import type { RefObject } from "react"
import type { UIMessage } from "@ai-sdk/react"
import { cn } from "../../../lib/utils"
import { ChatMessagesRenderer } from "./chat-messages-renderer"
import { ImplicitCollaborationTaskCards } from "../collaboration/implicit-collaboration-task-cards"
import { CollaborationSessionEventCards } from "../collaboration/collaboration-session-event-cards"
import type { ImplicitCollaborationTask } from "../collaboration/implicit-collaboration"

type CollaborationSession = ReturnType<
  typeof import("../collaboration/collaboration-session-runtime").useCollaborationSession
>

interface ActiveChatMessagesProps {
  messages: UIMessage<any>[]
  status: string
  conversationId: string
  chatId: string
  isActive: boolean
  isMobile?: boolean
  sandboxSetupStatus?: "cloning" | "ready" | "error"
  sandboxSetupError?: string
  onRetrySetup?: () => void
  stickyTopClass?: string
  chatContainerRef: RefObject<HTMLElement | null>
  chatContainerObserverRef: RefObject<ResizeObserver | null>
  contentWrapperRef: RefObject<HTMLDivElement | null>
  implicitCollaborationTasks: ImplicitCollaborationTask[]
  collaborationSession: CollaborationSession
  handleRollback: (msg: UIMessage<any>) => void
  handleForkFromMessage: (messageId: string) => void
}

export const ActiveChatMessages = memo(function ActiveChatMessages({
  messages,
  status,
  conversationId,
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
  implicitCollaborationTasks,
  collaborationSession,
  handleRollback,
  handleForkFromMessage,
}: ActiveChatMessagesProps) {
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
      emptyState={null}
      containerRef={(el) => {
        // Cleanup previous observer
        if (chatContainerObserverRef.current) {
          chatContainerObserverRef.current.disconnect()
          chatContainerObserverRef.current = null
        }

        chatContainerRef.current = el

        // Setup ResizeObserver for --chat-container-height/width CSS variables
        // Variables are set on both the element itself and the parent (relative wrapper)
        // so siblings like ScrollToBottomButton can also access them
        if (el) {
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
          chatContainerObserverRef.current = observer
        }
      }}
      contentWrapperRef={contentWrapperRef}
      className="flex-1 overflow-y-auto w-full relative allow-text-selection outline-none"
      contentClassName={cn("px-2 mx-auto -mb-4 max-w-2xl pb-8")}
      header={
        <>
          <ImplicitCollaborationTaskCards
            tasks={implicitCollaborationTasks}
          />
          <CollaborationSessionEventCards
            events={collaborationSession.events}
          />
        </>
      }
      onRollback={handleRollback}
      onFork={handleForkFromMessage}
    />
  )
})