"use client"

import { memo, useMemo } from "react"
import { useAtomValue } from "jotai"
import { userMessageIdsPerChatAtom } from "../stores/message-store"
import { IsolatedMessageGroup } from "./isolated-message-group"

// ============================================================================
// ISOLATED MESSAGES SECTION (LAYER 3)
// ============================================================================
// Renders ALL message groups by subscribing to userMessageIdsAtom.
// Only re-renders when a new user message is added (new conversation turn).
// Each group independently subscribes to its own data via IsolatedMessageGroup.
//
// During streaming:
// - This component does NOT re-render (userMessageIds don't change)
// - Individual groups don't re-render (their user msg + assistant IDs don't change)
// - Only the AssistantMessageItem for the streaming message re-renders
// ============================================================================

interface IsolatedMessagesSectionProps {
  conversationId: string
  chatId: string
  isMobile: boolean
  sandboxSetupStatus: "cloning" | "ready" | "error"
  stickyTopClass: string
  sandboxSetupError?: string
  onRetrySetup?: () => void
  onRollback?: (msg: any) => void
  onFork?: (messageId: string) => void
  // Components passed from parent - must be stable references
  UserBubbleComponent: React.ComponentType<{
    messageId: string
    textContent: string
    imageParts: any[]
    skipTextMentionBlocks?: boolean
  }>
  ToolCallComponent: React.ComponentType<{
    icon: any
    title: string
    isPending: boolean
    isError: boolean
  }>
  MessageGroupWrapper: React.ComponentType<{ children: React.ReactNode; isLastGroup?: boolean }>
  toolRegistry: Record<string, { icon: any; title: (args: any) => string }>
}

function areSectionPropsEqual(
  prev: IsolatedMessagesSectionProps,
  next: IsolatedMessagesSectionProps
): boolean {
  return (
    prev.conversationId === next.conversationId &&
    prev.chatId === next.chatId &&
    prev.isMobile === next.isMobile &&
    prev.sandboxSetupStatus === next.sandboxSetupStatus &&
    prev.stickyTopClass === next.stickyTopClass &&
    prev.sandboxSetupError === next.sandboxSetupError &&
    prev.onRetrySetup === next.onRetrySetup &&
    prev.onRollback === next.onRollback &&
    prev.onFork === next.onFork &&
    prev.UserBubbleComponent === next.UserBubbleComponent &&
    prev.ToolCallComponent === next.ToolCallComponent &&
    prev.MessageGroupWrapper === next.MessageGroupWrapper &&
    prev.toolRegistry === next.toolRegistry
  )
}

export const IsolatedMessagesSection = memo(function IsolatedMessagesSection({
  conversationId,
  chatId,
  isMobile,
  sandboxSetupStatus,
  stickyTopClass,
  sandboxSetupError,
  onRetrySetup,
  onRollback,
  onFork,
  UserBubbleComponent,
  ToolCallComponent,
  MessageGroupWrapper,
  toolRegistry,
}: IsolatedMessagesSectionProps) {
  // Per-conversation selector - split panes render fully independently.
  const userMsgIds = useAtomValue(userMessageIdsPerChatAtom(conversationId))

  // Message IDs normally come from the message store, but an optimistic or
  // malformed message can temporarily enter it without an id. Render only
  // valid groups so React does not see undefined/duplicate keys.
  const validUserMsgIds = useMemo(() => {
    const seen = new Set<string>()

    return userMsgIds.filter((userMsgId): userMsgId is string => {
      if (typeof userMsgId !== "string" || userMsgId.length === 0) {
        console.warn(
          "[IsolatedMessagesSection] Skipping message group without an id",
          { conversationId, userMsgId },
        )
        return false
      }

      if (seen.has(userMsgId)) {
        console.warn(
          "[IsolatedMessagesSection] Skipping duplicate message group id",
          { conversationId, userMsgId },
        )
        return false
      }

      seen.add(userMsgId)
      return true
    })
  }, [userMsgIds, conversationId])

  return (
    <>
      {validUserMsgIds.map((userMsgId) => (
        <IsolatedMessageGroup
          key={userMsgId}
          userMsgId={userMsgId}
          conversationId={conversationId}
          chatId={chatId}
          isMobile={isMobile}
          sandboxSetupStatus={sandboxSetupStatus}
          stickyTopClass={stickyTopClass}
          sandboxSetupError={sandboxSetupError}
          onRetrySetup={onRetrySetup}
          onRollback={onRollback}
          onFork={onFork}
          UserBubbleComponent={UserBubbleComponent}
          ToolCallComponent={ToolCallComponent}
          MessageGroupWrapper={MessageGroupWrapper}
          toolRegistry={toolRegistry}
        />
      ))}
    </>
  )
}, areSectionPropsEqual)
