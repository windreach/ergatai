"use client"

import { atom, useAtomValue } from "jotai"
import { atomFamily } from "jotai/utils"
import { memo, useCallback } from "react"
import {
  getPerChatMessageKey,
  isLastMessagePerChatAtomFamily,
  messageAtomFamily,
} from "../stores/message-store"
import type { Message, MessagePart } from "../stores/message-store"
import { useStreamingStatusStore } from "../stores/streaming-status-store"
import { AssistantMessageItem } from "./assistant-message-item"

// ============================================================================
// MESSAGE ITEM - Subscribes to its own message only
// ============================================================================

interface MessageItemWrapperProps {
  messageId: string
  conversationId: string
  chatId: string
  isMobile: boolean
  sandboxSetupStatus: "cloning" | "ready" | "error"
  agentIdentity?: { id: string; name: string }
}

// For non-last messages - no streaming subscription needed
// Subscribes to message via Jotai messageAtomFamily, passes message as prop to AssistantMessageItem
const NonStreamingMessageItem = memo(function NonStreamingMessageItem({
  messageId,
  conversationId,
  chatId,
  isMobile,
  sandboxSetupStatus,
  agentIdentity,
}: {
  messageId: string
  conversationId: string
  chatId: string
  isMobile: boolean
  sandboxSetupStatus: "cloning" | "ready" | "error"
  agentIdentity?: { id: string; name: string }
}) {
  // Subscribe to this specific message via Jotai - only re-renders when THIS message changes
  const messageKey = getPerChatMessageKey(conversationId, messageId)
  const message = useAtomValue(messageAtomFamily(messageKey))

  if (!message) return null

  return (
    <AssistantMessageItem
      message={message}
      isLastMessage={false}
      isStreaming={false}
      status="ready"
      conversationId={conversationId}
      chatId={chatId}
      isMobile={isMobile}
      sandboxSetupStatus={sandboxSetupStatus}
      agentIdentity={agentIdentity}
      showInterAgentReplies={true}
    />
  )
})

// For the last message - subscribes to streaming status AND message via Jotai
// Passes message as prop to AssistantMessageItem
const StreamingMessageItem = memo(function StreamingMessageItem({
  messageId,
  conversationId,
  chatId,
  isMobile,
  sandboxSetupStatus,
  agentIdentity,
}: {
  messageId: string
  conversationId: string
  chatId: string
  isMobile: boolean
  sandboxSetupStatus: "cloning" | "ready" | "error"
  agentIdentity?: { id: string; name: string }
}) {
  // Subscribe to this specific message via Jotai - only re-renders when THIS message changes
  const messageKey = getPerChatMessageKey(conversationId, messageId)
  const message = useAtomValue(messageAtomFamily(messageKey))

  // Subscribe to per-conversation streaming status
  const status = useStreamingStatusStore(
    useCallback((state) => state.statuses[conversationId] ?? "ready", [conversationId]),
  )
  const isStreaming = status === "streaming" || status === "submitted"

  if (!message) return null

  return (
    <AssistantMessageItem
      message={message}
      isLastMessage={true}
      isStreaming={isStreaming}
      status={status}
      conversationId={conversationId}
      chatId={chatId}
      isMobile={isMobile}
      sandboxSetupStatus={sandboxSetupStatus}
      agentIdentity={agentIdentity}
      showInterAgentReplies={true}
    />
  )
})

export const MessageItemWrapper = memo(function MessageItemWrapper({
  messageId,
  conversationId,
  chatId,
  isMobile,
  sandboxSetupStatus,
  agentIdentity,
}: MessageItemWrapperProps) {

  // Only subscribe to isLast - NOT to message content!
  // StreamingMessageItem and NonStreamingMessageItem will subscribe to message themselves
  const perChatKey = `${conversationId}:::${messageId}`
  const isLast = useAtomValue(isLastMessagePerChatAtomFamily(perChatKey))

  // Only the last message subscribes to streaming status
  if (isLast) {
    // StreamingMessageItem subscribes to messageAtomFamily internally
    return (
      <StreamingMessageItem
        messageId={messageId}
        conversationId={conversationId}
        chatId={chatId}
        isMobile={isMobile}
        sandboxSetupStatus={sandboxSetupStatus}
        agentIdentity={agentIdentity}
      />
    )
  }

  // NonStreamingMessageItem subscribes to messageAtomFamily internally
  return (
    <NonStreamingMessageItem
      messageId={messageId}
      conversationId={conversationId}
      chatId={chatId}
      isMobile={isMobile}
      sandboxSetupStatus={sandboxSetupStatus}
      agentIdentity={agentIdentity}
    />
  )
})

// ============================================================================
// MEMOIZED ASSISTANT MESSAGES - Only re-renders when message IDs change
// ============================================================================

// This is the KEY optimization component.
// By wrapping the assistant messages .map() in a memoized component that
// compares ONLY the message IDs (not the full message objects), we prevent
// the parent's re-render from causing MessageItemWrapper to be called.

interface MemoizedAssistantMessagesProps {
  assistantMsgIds: string[]
  conversationId: string
  chatId?: string
  isMobile: boolean
  sandboxSetupStatus: "cloning" | "ready" | "error"
}

function areMemoizedAssistantMessagesEqual(
  prev: MemoizedAssistantMessagesProps,
  next: MemoizedAssistantMessagesProps
): boolean {
  // Only re-render if IDs changed (new message added/removed)
  if (prev.assistantMsgIds.length !== next.assistantMsgIds.length) {
    return false
  }

  // Check if all IDs are the same
  for (let i = 0; i < prev.assistantMsgIds.length; i++) {
    if (prev.assistantMsgIds[i] !== next.assistantMsgIds[i]) {
      return false
    }
  }

  // Also check static props
  if (prev.conversationId !== next.conversationId) return false
  if (prev.chatId !== next.chatId) return false
  if (prev.isMobile !== next.isMobile) return false
  if (prev.sandboxSetupStatus !== next.sandboxSetupStatus) return false

  return true
}

// Merge consecutive single-part assistant messages into groups.
// ACP history import creates one message per sessionUpdate (tool_call,
// agent_thought_chunk, etc.), so a single turn becomes many 1-part messages.
// Merging them lets AssistantMessageItem render them as one unit with a
// proper "N steps" collapsible header.
interface MergedMsgGroup {
  /** Use first message's id as the group key. */
  id: string
  /** True when this group contains more than one original message. */
  merged: boolean
  /** All original message ids in this group (for key tracking). */
  ids: string[]
  /** Merged parts from all messages in the group. */
  parts: MessagePart[]
  /** First message's metadata (determines role styling). */
  metadata?: Record<string, unknown>
  /** Last message id in the group (for isLastMessage detection). */
  lastId: string
}

function buildMergedMsgGroups(
  assistantMsgIds: string[],
  messages: Message[],
): MergedMsgGroup[] {
  if (assistantMsgIds.length === 0) return []

  // Build a quick id→message lookup (only for the IDs we care about).
  const byId = new Map<string, Message>()
  for (const m of messages) {
    if (m.role !== "assistant") continue
    byId.set(m.id, m)
  }

  const groups: MergedMsgGroup[] = []
  let buf: Message[] = []

  const flush = () => {
    if (buf.length === 0) return
    const first = buf[0]
    const last = buf[buf.length - 1]
    const mergedParts = buf.flatMap((m) => m.parts ?? [])
    groups.push({
      id: first.id,
      merged: buf.length > 1,
      ids: buf.map((m) => m.id),
      parts: mergedParts,
      metadata: first.metadata,
      lastId: last.id,
    })
    buf = []
  }

  for (const id of assistantMsgIds) {
    const msg = byId.get(id)
    if (!msg) {
      // Unknown message — flush buffer and render standalone via wrapper.
      flush()
      groups.push({ id, merged: false, ids: [id], parts: [], lastId: id })
      continue
    }

    const parts = msg.parts ?? []
    const isSingleNonText =
      parts.length === 1 && parts[0].type !== "text"

    if (isSingleNonText && buf.length > 0) {
      // Extend current merge buffer.
      buf.push(msg)
    } else if (isSingleNonText && buf.length === 0) {
      // Start a new merge buffer.
      buf.push(msg)
    } else {
      // Multi-part or text message — flush buffer and render standalone.
      flush()
      groups.push({
        id,
        merged: false,
        ids: [id],
        parts,
        metadata: msg.metadata,
        lastId: id,
      })
    }
  }
  flush()

  return groups
}

// Renders a merged group of assistant messages as a single AssistantMessageItem.
const MergedAssistantItem = memo(function MergedAssistantItem({
  group,
  conversationId,
  chatId,
  isMobile,
  sandboxSetupStatus,
  isLastMessage,
  isStreaming,
}: {
  group: MergedMsgGroup
  conversationId: string
  chatId: string
  isMobile: boolean
  sandboxSetupStatus: "cloning" | "ready" | "error"
  isLastMessage: boolean
  isStreaming: boolean
}) {
  // Build a synthetic message object that AssistantMessageItem can consume.
  const synthetic: Message = {
    id: group.id,
    role: "assistant",
    parts: group.parts,
    metadata: group.metadata,
  }

  return (
    <AssistantMessageItem
      message={synthetic}
      isLastMessage={isLastMessage}
      isStreaming={isStreaming}
      status={isStreaming ? "streaming" : "ready"}
      conversationId={conversationId}
      chatId={chatId}
      isMobile={isMobile}
      sandboxSetupStatus={sandboxSetupStatus}
      showInterAgentReplies={true}
    />
  )
})

// Atom family for merged message groups
// Key format: "conversationId:::id1,id2,id3..."
const mergedMsgGroupsAtomFamily = atomFamily((key: string) => {
  const sepIdx = key.indexOf(":::")
  const conversationId = key.slice(0, sepIdx)
  const idsStr = key.slice(sepIdx + 3)
  const assistantMsgIds = idsStr ? idsStr.split(",") : []

  return atom((get) => {
    const messages: Message[] = []
    for (const id of assistantMsgIds) {
      const msg = get(messageAtomFamily(getPerChatMessageKey(conversationId, id)))
      if (msg !== null) {
        messages.push(msg)
      }
    }
    return buildMergedMsgGroups(assistantMsgIds, messages)
  })
})

export const MemoizedAssistantMessages = memo(function MemoizedAssistantMessages({
  assistantMsgIds,
  conversationId,
  chatId,
  isMobile,
  sandboxSetupStatus,
}: MemoizedAssistantMessagesProps) {
  // Get streaming status from the dedicated store
  const streamingStatus = useStreamingStatusStore(
    useCallback((state) => state.statuses[conversationId] ?? "ready", [conversationId]),
  )
  const isStreaming = streamingStatus === "streaming" || streamingStatus === "submitted"

  const lastId = assistantMsgIds.length > 0 ? assistantMsgIds[assistantMsgIds.length - 1] : null

  // Build merged groups using atomFamily - safely handles dynamic message IDs
  const groupsKey = `${conversationId}:::${assistantMsgIds.join(",")}`
  const groups = useAtomValue(mergedMsgGroupsAtomFamily(groupsKey))

  return (
    <>
      {groups.map((group) => {
        // Non-merged (multi-part) messages render through the normal wrapper.
        if (!group.merged) {
          return (
            <MessageItemWrapper
              key={group.id}
              messageId={group.id}
              conversationId={conversationId}
              chatId={chatId ?? conversationId}
              isMobile={isMobile}
              sandboxSetupStatus={sandboxSetupStatus}
            />
          )
        }

        // Merged group: render as a single AssistantMessageItem.
        const isLast = group.lastId === lastId

        return (
          <MergedAssistantItem
            key={group.id}
            group={group}
            conversationId={conversationId}
            chatId={chatId ?? conversationId}
            isMobile={isMobile}
            sandboxSetupStatus={sandboxSetupStatus}
            isLastMessage={isLast}
            isStreaming={isLast ? isStreaming : false}
          />
        )
      })}
    </>
  )
}, areMemoizedAssistantMessagesEqual)
