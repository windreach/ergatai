"use client"

import { memo, useCallback } from "react"
import type { RefObject } from "react"
import type { UIMessage } from "@ai-sdk/react"
import { cn } from "../../../lib/utils"
// import { useAtom } from "jotai"
import { ChatMessagesRenderer } from "./chat-messages-renderer"
// TODO(subagent): temporarily not consumed. Subagent conversation rendering disabled.
// import { selectedSubagentSessionIdAtomFamily } from "../lib/subagent-message-store"
// import { SubagentConversationView } from "../ui/subagent-conversation-view"
import { useConversationHistoryImport } from "../hooks/use-conversation-history-import"
import { useHostReplySync } from "../hooks/use-host-reply-sync"
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
  /** Extra class names merged into the message content wrapper. */
  contentClassName?: string
  /** Rendered after the last message, inside the scroll container. */
  footer?: React.ReactNode
  /** Hide error cards while an automatic retry is in progress. */
  suppressErrorCards?: boolean
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
  contentClassName,
  footer,
  suppressErrorCards = false,
}: ActiveChatMessagesProps) {

  const { importBanner } = useConversationHistoryImport({
    conversationId,
    agentId,
    containerRef: chatContainerRef,
  })

  // Sync external-agent replies into the main chat store as native messages,
  // so they render in correct sequence order without a separate async bridge.
  useHostReplySync(conversationId)

  const setContainerRef = useCallback((el: HTMLDivElement | null) => {
    chatContainerRef.current = el
    const observerRef = chatContainerObserverRef

    // React 19 calls a ref callback with null on detach (and also supports the
    // returned cleanup below on newer renderers). Release the previous
    // observer either way so keeping the chat mounted cannot leak it.
    observerRef?.current?.disconnect()
    if (observerRef) {
      observerRef.current = null
    }

    if (!el || !observerRef) {
      return
    }

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

    return () => {
      observer.disconnect()
      if (observerRef.current === observer) {
        observerRef.current = null
      }
      if (chatContainerRef.current === el) {
        chatContainerRef.current = null
      }
    }
  }, [chatContainerRef, chatContainerObserverRef])

  // TODO(subagent): temporarily not consumed. Subagent conversation rendering disabled.
  // const [selectedSubagentSessionId, setSelectedSubagentSessionId] = useAtom(
  //   selectedSubagentSessionIdAtomFamily(conversationId),
  // )
  //
  // if (selectedSubagentSessionId) {
  //   return (
  //     <div className="flex-1 overflow-y-auto w-full relative allow-text-selection outline-none">
  //       <div className="px-2 mx-auto max-w-2xl pb-8">
  //         <SubagentConversationView
  //           agentId={agentId ?? null}
  //           subagentSessionId={selectedSubagentSessionId}
  //           onBack={() => setSelectedSubagentSessionId(null)}
  //         />
  //       </div>
  //     </div>
  //   )
  // }

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
      containerRef={setContainerRef}
      contentWrapperRef={contentWrapperRef}
      className="flex-1 overflow-y-auto w-full relative allow-text-selection outline-none"
      contentClassName={cn("px-2 mx-auto -mb-4 max-w-2xl pb-8", contentClassName)}
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
      footer={footer}
      suppressErrorCards={suppressErrorCards}
      onRollback={handleRollback}
      onFork={handleForkFromMessage}
    />
  )
})