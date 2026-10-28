"use client"

import { memo, useEffect, useMemo } from "react"
import { useAtomValue } from "jotai"
import type { UIMessage } from "@ai-sdk/react"
import {
  userMessageIdsPerChatAtom,
} from "../stores/message-store"
import { IsolatedMessageGroup } from "./isolated-message-group"
import type { ToolPart } from "../ui/agent-tool-registry"

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

/**
 * Image part shape for inline image attachments. Must stay structurally
 * identical to the `ImagePart` type in `isolated-message-group.tsx`, since
 * that component's `UserBubbleComponent` prop is typed against it.
 */
type ImagePart = {
  type?: "data-image" | string
  data?: {
    filename?: string
    url?: string
    base64Data?: string
    mediaType?: string
  }
}

/** Icon component accepted by `ToolCallComponent` — matches `ToolMeta.icon`. */
type ToolIcon = React.ComponentType<{ className?: string }>

interface IsolatedMessagesSectionProps {
  conversationId: string
  chatId: string
  isMobile: boolean
  sandboxSetupStatus: "cloning" | "ready" | "error"
  stickyTopClass: string
  sandboxSetupError?: string
  onRetrySetup?: () => void
  onRollback?: (msg: UIMessage) => void
  onFork?: (messageId: string) => void
  // Components passed from parent - must be stable references
  UserBubbleComponent: React.ComponentType<{
    messageId: string
    textContent: string
    imageParts: ImagePart[]
    skipTextMentionBlocks?: boolean
  }>
  ToolCallComponent: React.ComponentType<{
    icon: ToolIcon
    title: string
    isPending: boolean
    isError: boolean
  }>
  MessageGroupWrapper: React.ComponentType<{ children: React.ReactNode; isLastGroup?: boolean }>
  toolRegistry: Record<string, { icon: ToolIcon; title: (args: ToolPart) => string }>
}

/**
 * Shallow equality helper: compares two prop objects by own-key identity.
 * Avoids the fragility of manually listing every prop (adding a new prop
 * no longer requires also remembering to extend this function).
 */
function shallowEqualProps<T extends Record<string, unknown>>(a: T, b: T): boolean {
  if (a === b) return true
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false
  for (const key of aKeys) {
    if (a[key] !== b[key]) return false
  }
  return true
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
    const out: string[] = []
    for (const userMsgId of userMsgIds) {
      if (typeof userMsgId !== "string" || userMsgId.length === 0) continue
      if (seen.has(userMsgId)) continue
      seen.add(userMsgId)
      out.push(userMsgId)
    }
    return out
  }, [userMsgIds])

  // Validation warnings live in an effect so the render pass stays pure.
  useEffect(() => {
    const seen = new Set<string>()
    for (const userMsgId of userMsgIds) {
      if (typeof userMsgId !== "string" || userMsgId.length === 0) {
        // eslint-disable-next-line no-console
        console.warn(
          "[IsolatedMessagesSection] Skipping message group without an id",
          { conversationId, userMsgId },
        )
        continue
      }
      if (seen.has(userMsgId)) {
        // eslint-disable-next-line no-console
        console.warn(
          "[IsolatedMessagesSection] Skipping duplicate message group id",
          { conversationId, userMsgId },
        )
        continue
      }
      seen.add(userMsgId)
    }
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
}, shallowEqualProps as (a: IsolatedMessagesSectionProps, b: IsolatedMessagesSectionProps) => boolean)
