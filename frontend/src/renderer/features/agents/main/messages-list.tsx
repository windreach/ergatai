"use client"

import { atom, useAtomValue } from "jotai"
import { atomFamily } from "jotai/utils"
import { memo, useCallback } from "react"
import {
  getMessageTurnId,
  getPerChatMessageKey,
  messageAtomFamily,
} from "../stores/message-store"
import type { Message, MessagePart } from "../stores/message-store"
import { useStreamingStatusStore } from "../stores/streaming-status-store"
import { AssistantMessageItem } from "./assistant-message-item"

// ============================================================================
// MEMOIZED ASSISTANT MESSAGES - Only re-renders when message IDs change
// ============================================================================

// This is the KEY optimization component.
// By wrapping the assistant messages .map() in a memoized component that
// compares ONLY the message IDs (not the full message objects), we prevent
// the parent's re-render from causing AssistantMessageGroupItem to be called.

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

// Merge consecutive assistant messages into render units.
//
// A single user turn can produce several assistant messages:
//   - ACP history import creates one message per sessionUpdate (tool_call,
//     agent_thought_chunk, ...), so one turn becomes many 1-part messages.
//   - Agents can emit a tool-only assistant turn followed by a second turn
//     containing the final answer.
// Rendering each message independently means earlier tool-only turns can never
// be collapsed (they have no text), which produces the "Thinking / tool above,
// 'N steps' below" layout. Instead, buffer consecutive assistant messages that
// contain no visible text and merge them into the next message that does.
// The resulting synthetic message lets AssistantMessageItem collapse the whole
// turn's steps behind a single header.
interface MergedMsgGroup {
  /** Stable React key: backend turn id when available, otherwise first message id. */
  key: string
  /** Use first message's id as the group key. */
  id: string
  /** True when this group contains more than one original message. */
  merged: boolean
  /** All original message ids in this group (for key tracking). */
  ids: string[]
  /** Merged parts from all messages in the group. */
  parts: MessagePart[]
  /** Union of metadata from the group (later messages win on conflicts). */
  metadata?: Record<string, unknown>
  /** Last message id in the group (for isLastMessage detection). */
  lastId: string
}

function hasVisibleText(parts: MessagePart[]): boolean {
  return parts.some(
    (part) =>
      part.type === "text" &&
      typeof part.text === "string" &&
      part.text.trim().length > 0,
  )
}

/**
 * React keys must survive the runtime → persisted handoff. The backend turn id
 * stays the same across local, runtime, and canonical projections, while the
 * message id changes from the ephemeral projection id to the durable id.
 * Fall back to the message id for imported history that has no turn id.
 */
function getGroupKey(message: Message): string {
  return getMessageTurnId(message) ?? message.id
}

function uniqueGroupKey(base: string, usedKeys: Set<string>): string {
  let key = base
  let suffix = 1
  while (usedKeys.has(key)) {
    key = `${base}#${suffix}`
    suffix += 1
  }
  usedKeys.add(key)
  return key
}

export function buildMergedMsgGroups(
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
  const usedKeys = new Set<string>()
  let buf: Message[] = []

  const flush = () => {
    if (buf.length === 0) return
    const first = buf[0]
    const last = buf[buf.length - 1]
    const mergedParts = buf.flatMap((m) => m.parts ?? [])
    const metadata = buf.reduce<Record<string, unknown> | undefined>(
      (acc, message) =>
        message.metadata
          ? { ...(acc ?? {}), ...message.metadata }
          : acc,
      undefined,
    )
    groups.push({
      key: uniqueGroupKey(getGroupKey(first), usedKeys),
      id: first.id,
      merged: buf.length > 1,
      ids: buf.map((m) => m.id),
      parts: mergedParts,
      metadata,
      lastId: last.id,
    })
    buf = []
  }

  for (const id of assistantMsgIds) {
    const msg = byId.get(id)
    if (!msg) {
      // Unknown message — flush buffer and render standalone via wrapper.
      flush()
      groups.push({
        key: uniqueGroupKey(id, usedKeys),
        id,
        merged: false,
        ids: [id],
        parts: [],
        lastId: id,
      })
      continue
    }

    const parts = msg.parts ?? []

    if (!hasVisibleText(parts)) {
      // Tool / reasoning only — wait for the message that carries the answer.
      buf.push(msg)
      continue
    }

    if (buf.length > 0) {
      // Attach the final-text message to the preceding step messages so the
      // whole turn renders as one collapsible unit.
      buf.push(msg)
      flush()
      continue
    }

    // Standalone message with text — flush and render on its own.
    groups.push({
      key: uniqueGroupKey(getGroupKey(msg), usedKeys),
      id,
      merged: false,
      ids: [id],
      parts,
      metadata: msg.metadata,
      lastId: id,
    })
  }
  flush()

  return groups
}

// Renders one assistant render unit. A unit can either be a single message
// (non-merged) or several messages merged because they belong to the same
// user turn. Keeping a single component type for both cases is important:
// when a tool-only message turns into a merged group as the next turn starts,
// React updates this component instead of remounting the whole message tree.
interface AssistantMessageGroupItemProps {
  group: MergedMsgGroup
  conversationId: string
  chatId: string
  isMobile: boolean
  sandboxSetupStatus: "cloning" | "ready" | "error"
  isLastMessage: boolean
  isStreaming: boolean
  status: string
}

function arePartsEqual(a: MessagePart[], b: MessagePart[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

function areMetadataEqual(
  a: Record<string, unknown> | undefined,
  b: Record<string, unknown> | undefined,
): boolean {
  if (a === b) return true
  if (!a || !b) return false
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false
  for (const key of aKeys) {
    if (a[key] !== b[key]) return false
  }
  return true
}

function areAssistantMessageGroupItemPropsEqual(
  prev: AssistantMessageGroupItemProps,
  next: AssistantMessageGroupItemProps,
): boolean {
  if (prev.group.key !== next.group.key) return false
  if (prev.group.id !== next.group.id) return false
  if (prev.group.merged !== next.group.merged) return false
  if (prev.conversationId !== next.conversationId) return false
  if (prev.chatId !== next.chatId) return false
  if (prev.isMobile !== next.isMobile) return false
  if (prev.sandboxSetupStatus !== next.sandboxSetupStatus) return false
  if (prev.isLastMessage !== next.isLastMessage) return false
  if (prev.isStreaming !== next.isStreaming) return false
  if (prev.status !== next.status) return false

  if (next.group.merged) {
    // Message atoms hold immutable snapshots, so unchanged parts keep their
    // object identity. This lets merged groups re-render only for real changes.
    if (!arePartsEqual(prev.group.parts, next.group.parts)) return false
    if (!areMetadataEqual(prev.group.metadata, next.group.metadata)) return false
  }

  return true
}

const AssistantMessageGroupItem = memo(function AssistantMessageGroupItem({
  group,
  conversationId,
  chatId,
  isMobile,
  sandboxSetupStatus,
  isLastMessage,
  isStreaming,
  status,
}: AssistantMessageGroupItemProps) {
  // Subscribe to the group's first message. Non-merged groups render this
  // message directly; merged groups use the synthetic group projection but
  // still benefit from the same subscription lifecycle.
  const message = useAtomValue(
    messageAtomFamily(getPerChatMessageKey(conversationId, group.id)),
  )

  const messageToRender: Message | null = group.merged
    ? {
        id: group.id,
        role: "assistant",
        parts: group.parts,
        metadata: group.metadata,
      }
    : message

  if (!messageToRender) return null

  return (
    <AssistantMessageItem
      renderKey={group.key}
      message={messageToRender}
      isLastMessage={isLastMessage}
      isStreaming={isStreaming}
      status={status}
      conversationId={conversationId}
      chatId={chatId}
      isMobile={isMobile}
      sandboxSetupStatus={sandboxSetupStatus}
      showInterAgentReplies={true}
    />
  )
}, areAssistantMessageGroupItemPropsEqual)

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
        const isLast = group.lastId === lastId
        return (
          <AssistantMessageGroupItem
            key={group.key}
            group={group}
            conversationId={conversationId}
            chatId={chatId ?? conversationId}
            isMobile={isMobile}
            sandboxSetupStatus={sandboxSetupStatus}
            isLastMessage={isLast}
            isStreaming={isLast ? isStreaming : false}
            status={isLast ? streamingStatus : "ready"}
          />
        )
      })}
    </>
  )
}, areMemoizedAssistantMessagesEqual)
