"use client"

import { atom } from "jotai"
import { atomFamily } from "jotai/utils"
import { appStore } from "../../../lib/jotai-store"

// Types
export type MessageRole = "user" | "assistant" | "system" | "agent"

/**
 * Message role policies - centralized logic for how different roles behave.
 * This avoids scattered role checks throughout the codebase.
 */
export const MessageRolePolicy = {
  /**
   * Roles that start a new conversation group.
   * user: human input
   * agent: agent-initiated messages (request to other agents)
   */
  startsNewGroup(role: MessageRole): boolean {
    return role === "user" || role === "agent"
  },

  /**
   * Roles that append to the current conversation group.
   * assistant: agent responses and outputs
   * system: system events and notifications
   */
  appendsToGroup(role: MessageRole): boolean {
    return role === "assistant" || role === "system"
  },

  /**
   * Roles that represent human or agent initiators (not responses).
   * Used for statistics and filtering.
   */
  isInitiator(role: MessageRole): boolean {
    return role === "user" || role === "agent"
  },
}

export interface MessagePart {
  type: string
  text?: string
  toolCallId?: string
  state?: string
  input?: Record<string, unknown>
  output?: unknown
  result?: unknown
  [key: string]: unknown
}

export interface Message {
  id: string
  role: MessageRole
  parts?: MessagePart[]
  metadata?: Record<string, unknown>
  createdAt?: Date
  /** Local sequence number for stable ordering (added by runtime) */
  sequence?: number
}

// ============================================================================
// MESSAGE STORE - OPTIMIZED ARCHITECTURE
// ============================================================================
// Key insight: Jotai atomFamily creates INDEPENDENT atoms for each key.
// When we use atomFamily with primitive atoms (not derived), each message
// has its own atom that can be updated without affecting other messages.
//
// Architecture:
// - messageAtomFamily: atomFamily<messageId, Message | null> - INDEPENDENT atoms per message
// - messageIdsAtom: string[] - ordered list of message IDs for rendering
// - messageRolesAtom: Map<messageId, role> - cached roles for grouping (avoids reading all messages)
// - lastMessageIdAtom: derived atom for the last message ID
// - streamingMessageIdAtom: ID of currently streaming message (or null)
//
// During streaming:
// - Only the streaming message's atom is updated
// - Other message atoms remain unchanged → no re-renders
// ============================================================================

// Per-message atom family - each message has its own INDEPENDENT atom
// Key format: "<conversationId>:::<messageId>".
// This guarantees full per-chat isolation even when message IDs overlap across chats.
export const getPerChatMessageKey = (conversationId: string, messageId: string) =>
  `${conversationId}:::${messageId}`

// This is the key optimization: updating one message doesn't affect others.
export const messageAtomFamily = atomFamily((_messageKey: string) =>
  atom<Message | null>(null)
)

// Track active message IDs per conversation for cleanup
const activeMessageIdsByChat = new Map<string, Set<string>>()

// Ordered list of message IDs (for rendering order)
export const messageIdsAtom = atom<string[]>([])

// Message roles cache - updated only when messages are added/removed
// This avoids reading all message atoms just to check roles
const messageRolesAtom = atom<Map<string, MessageRole>>(new Map())

// Per-conversation atoms for split-pane rendering. Each pane reads only its own IDs/roles.
export const messageIdsPerChatAtom = atomFamily((_conversationId: string) =>
  atom<string[]>([])
)

const messageRolesPerChatAtom = atomFamily((_conversationId: string) =>
  atom<Map<string, MessageRole>>(new Map())
)

// Currently streaming message ID (null if not streaming)
export const streamingMessageIdAtom = atom<string | null>(null)

// Chat status atom
export const chatStatusAtom = atom<string>("ready")

// Global rollback state - prevents multiple rollbacks across all chats
export const isRollingBackAtom = atom<boolean>(false)

// Current conversationId - used to isolate caches per chat
export const currentConversationIdAtom = atom<string>("default")

// Last message ID - derived (uses stable messageIdsAtom)
export const lastMessageIdAtom = atom((get) => {
  const ids = get(messageIdsAtom)
  return ids.length > 0 ? ids[ids.length - 1] : null
})

// ============================================================================
// SELECTORS
// ============================================================================

// Check if a specific message is the last one
export const isLastMessageAtomFamily = atomFamily((messageId: string) =>
  atom((get) => get(lastMessageIdAtom) === messageId)
)

// Per-conversation version for split panes.
// Key format: "conversationId:::messageId"
export const isLastMessagePerChatAtomFamily = atomFamily((key: string) => {
  const sepIdx = key.indexOf(":::")
  const conversationId = key.slice(0, sepIdx)
  const messageId = key.slice(sepIdx + 3)
  return atom((get) => {
    const ids = get(messageIdsPerChatAtom(conversationId))
    return ids.length > 0 && ids[ids.length - 1] === messageId
  })
})

// Check if a specific message is currently streaming
export const isMessageStreamingAtomFamily = atomFamily((messageId: string) =>
  atom((get) => {
    const streamingId = get(streamingMessageIdAtom)
    const lastId = get(lastMessageIdAtom)
    // A message is streaming if it's the last message and there's active streaming
    return messageId === lastId && streamingId === messageId
  })
)

// ============================================================================
// TEXT PART ATOMS - For IsolatedTextPart optimization
// ============================================================================
// Problem: When IsolatedTextPart subscribes to messageAtomFamily, ALL text parts
// of that message re-render when ANY part changes (even tool parts).
//
// Solution: Create a derived atom that extracts ONLY the specific text part.
// This way, a text part only re-renders when ITS text changes, not when
// other parts of the same message change.

// Cache for text part content to return stable references
const textPartCache = new Map<string, string>()

export const textPartAtomFamily = atomFamily((key: string) => {
  // Key format: "<messageKey>:<partIndex>".
  // messageKey can include ":" so split from the end.
  const sepIdx = key.lastIndexOf(":")
  const messageKey = key.slice(0, sepIdx)
  const partIndexStr = key.slice(sepIdx + 1)
  const partIndex = parseInt(partIndexStr!, 10)

  return atom((get) => {
    const message = get(messageAtomFamily(messageKey))
    const parts = message?.parts || []
    const part = parts[partIndex]
    const text = part?.type === "text" ? (part.text || "") : ""

    // Return cached value if text hasn't changed (stable reference)
    const cached = textPartCache.get(key)
    if (cached === text) {
      return cached
    }

    textPartCache.set(key, text)
    return text
  })
})

// ============================================================================
// MESSAGE PARTS STRUCTURE - For AssistantMessageItem optimization
// ============================================================================
// Problem: AssistantMessageItem subscribes to the whole message object.
// When ANY part changes (including text content), the whole component re-renders,
// causing all IsolatedTextPart children to re-render.
//
// Solution: Create an atom that returns only the STRUCTURE of parts (types, states,
// toolCallIds) without text content. This way AssistantMessageItem only re-renders
// when the structure changes (new part added, tool state changed), not when text
// content streams in.

interface PartStructure {
  type: string
  toolCallId?: string
  state?: string
  // For tools we need input to determine rendering
  inputJson?: string
  // For tool results
  hasOutput?: boolean
  hasResult?: boolean
  hasError?: boolean
  // For text parts - whether text is non-empty (without including actual text)
  hasText?: boolean
}

interface MessageStructure {
  id: string
  role: MessageRole
  partsStructure: PartStructure[]
  metadata?: Record<string, unknown>
}

// Cache for message structure
const messageStructureCache = new Map<string, MessageStructure>()

export const messageStructureAtomFamily = atomFamily((messageKey: string) =>
  atom((get) => {
    const message = get(messageAtomFamily(messageKey))
    if (!message) return null

    // Build structure without text content
    const partsStructure: PartStructure[] = (message.parts || []).map((part: MessagePart) => {
      const structure: PartStructure = {
        type: part.type,
      }
      if (part.toolCallId) structure.toolCallId = part.toolCallId
      if (part.state) structure.state = part.state
      // For tools, include input as JSON for comparison
      if (part.input) structure.inputJson = JSON.stringify(part.input)
      if (part.output !== undefined) structure.hasOutput = true
      if (part.result !== undefined) structure.hasResult = true
      if (part.error !== undefined || part.errorText !== undefined) structure.hasError = true
      // For text parts, track whether text is non-empty (without including actual text)
      if (part.type === "text") structure.hasText = !!part.text?.trim()
      return structure
    })

    const newStructure: MessageStructure = {
      id: message.id,
      role: message.role,
      partsStructure,
      metadata: message.metadata,
    }

    // Check if structure changed
    const cached = messageStructureCache.get(messageKey)
    if (cached) {
      // Compare structures
      if (
        cached.id === newStructure.id &&
        cached.role === newStructure.role &&
        cached.partsStructure.length === newStructure.partsStructure.length &&
        cached.partsStructure.every((p, i) => {
          const n = newStructure.partsStructure[i]
          return (
            p.type === n?.type &&
            p.toolCallId === n?.toolCallId &&
            p.state === n?.state &&
            p.inputJson === n?.inputJson &&
            p.hasOutput === n?.hasOutput &&
            p.hasResult === n?.hasResult &&
            p.hasError === n?.hasError &&
            p.hasText === n?.hasText
          )
        }) &&
        // Shallow compare metadata (for usage tracking)
        cached.metadata === message.metadata
      ) {
        return cached
      }
    }

    messageStructureCache.set(messageKey, newStructure)
    return newStructure
  })
)

// ============================================================================
// USER MESSAGE IDS - For IsolatedMessagesSection
// ============================================================================
// Uses a cache to return stable reference when IDs haven't changed
// Cache is per-conversationId to avoid collisions between different chats

const userMessageIdsCacheByChat = new Map<string, string[]>()
export const userMessageIdsAtom = atom((get) => {
  const ids = get(messageIdsAtom)
  const roles = get(messageRolesAtom)
  const conversationId = get(currentConversationIdAtom)
  const newUserIds = ids.filter((id) => {
    const role = roles.get(id)
    return role && MessageRolePolicy.isInitiator(role)
  })

  // Return cached array if content is the same
  const cached = userMessageIdsCacheByChat.get(conversationId)
  if (
    cached &&
    newUserIds.length === cached.length &&
    newUserIds.every((id, i) => id === cached[i])
  ) {
    return cached
  }

  userMessageIdsCacheByChat.set(conversationId, newUserIds)
  return newUserIds
})

// Per-conversation version for split panes
const userMessageIdsPerChatCache = new Map<string, string[]>()
export const userMessageIdsPerChatAtom = atomFamily((conversationId: string) =>
  atom((get) => {
    const ids = get(messageIdsPerChatAtom(conversationId))
    const roles = get(messageRolesPerChatAtom(conversationId))
    const newUserIds = ids.filter((id) => {
      const role = roles.get(id)
      return role && MessageRolePolicy.isInitiator(role)
    })

    const cached = userMessageIdsPerChatCache.get(conversationId)
    if (
      cached &&
      newUserIds.length === cached.length &&
      newUserIds.every((id, i) => id === cached[i])
    ) {
      return cached
    }

    userMessageIdsPerChatCache.set(conversationId, newUserIds)
    return newUserIds
  })
)

// ============================================================================
// MESSAGE GROUPS - For rendering structure
// ============================================================================

type MessageGroupType = { userMsgId: string; assistantMsgIds: string[] }
const messageGroupsCacheByChat = new Map<string, MessageGroupType[]>()

export const messageGroupsAtom = atom((get) => {
  const ids = get(messageIdsAtom)
  const roles = get(messageRolesAtom)
  const conversationId = get(currentConversationIdAtom)

  const groups: MessageGroupType[] = []
  let currentGroup: MessageGroupType | null = null

  for (const id of ids) {
    const role = roles.get(id)
    if (!role) continue

    // Check if this role starts a new conversation group
    if (MessageRolePolicy.startsNewGroup(role)) {
      if (currentGroup) {
        groups.push(currentGroup)
      }
      currentGroup = { userMsgId: id, assistantMsgIds: [] }
    } else if (currentGroup && role === "assistant") {
      currentGroup.assistantMsgIds.push(id)
    }
  }

  if (currentGroup) {
    groups.push(currentGroup)
  }

  // Check if groups structurally match cached
  const cachedMessageGroups = messageGroupsCacheByChat.get(conversationId) ?? []
  if (groups.length === cachedMessageGroups.length) {
    let allMatch = true
    for (let i = 0; i < groups.length; i++) {
      const newGroup = groups[i]
      const cachedGroup = cachedMessageGroups[i]
      if (
        newGroup.userMsgId !== cachedGroup?.userMsgId ||
        newGroup.assistantMsgIds.length !== cachedGroup?.assistantMsgIds.length ||
        !newGroup.assistantMsgIds.every((id, j) => id === cachedGroup?.assistantMsgIds[j])
      ) {
        allMatch = false
        break
      }
    }
    if (allMatch) {
      return cachedMessageGroups
    }
  }

  messageGroupsCacheByChat.set(conversationId, groups)
  return groups
})

// Per-conversation message groups for split panes
function buildMessageGroups(ids: string[], roles: Map<string, MessageRole>): MessageGroupType[] {
  const groups: MessageGroupType[] = []
  let currentGroup: MessageGroupType | null = null

  for (const id of ids) {
    const role = roles.get(id)
    if (!role) continue

    // Check if this role starts a new conversation group
    if (MessageRolePolicy.startsNewGroup(role)) {
      if (currentGroup) groups.push(currentGroup)
      currentGroup = { userMsgId: id, assistantMsgIds: [] }
    } else if (currentGroup && role === "assistant") {
      currentGroup.assistantMsgIds.push(id)
    }
  }

  if (currentGroup) groups.push(currentGroup)
  return groups
}

const messageGroupsPerChatCache = new Map<string, MessageGroupType[]>()
const messageGroupsPerChatAtom = atomFamily((conversationId: string) =>
  atom((get) => {
    const ids = get(messageIdsPerChatAtom(conversationId))
    const roles = get(messageRolesPerChatAtom(conversationId))
    const groups = buildMessageGroups(ids, roles)

    const cached = messageGroupsPerChatCache.get(conversationId) ?? []
    if (groups.length === cached.length) {
      let allMatch = true
      for (let i = 0; i < groups.length; i++) {
        const newGroup = groups[i]
        const cachedGroup = cached[i]
        if (
          newGroup?.userMsgId !== cachedGroup?.userMsgId ||
          newGroup?.assistantMsgIds.length !== cachedGroup?.assistantMsgIds.length ||
          !newGroup?.assistantMsgIds.every((id, j) => id === cachedGroup?.assistantMsgIds[j])
        ) {
          allMatch = false
          break
        }
      }
      if (allMatch) {
        return cached
      }
    }

    messageGroupsPerChatCache.set(conversationId, groups)
    return groups
  })
)

// ============================================================================
// ASSISTANT IDS FOR USER MESSAGE - For IsolatedMessageGroup
// ============================================================================

// Per-conversation versions for split panes
// Key format: "conversationId:::userMsgId"
const assistantIdsPerChatCache = new Map<string, string[]>()
export const assistantIdsPerChatAtomFamily = atomFamily((key: string) => {
  const sepIdx = key.indexOf(":::")
  const conversationId = key.slice(0, sepIdx)
  const userMsgId = key.slice(sepIdx + 3)
  return atom((get) => {
    const groups = get(messageGroupsPerChatAtom(conversationId))
    const group = groups.find((g) => g.userMsgId === userMsgId)
    const newIds = group?.assistantMsgIds ?? []
    const cached = assistantIdsPerChatCache.get(key)

    if (
      cached &&
      cached.length === newIds.length &&
      cached.every((id, i) => id === newIds[i])
    ) {
      return cached
    }

    assistantIdsPerChatCache.set(key, newIds)
    return newIds
  })
})

export const isLastUserMessagePerChatAtomFamily = atomFamily((key: string) => {
  const sepIdx = key.indexOf(":::")
  const conversationId = key.slice(0, sepIdx)
  const userMsgId = key.slice(sepIdx + 3)
  return atom((get) => {
    const userIds = get(userMessageIdsPerChatAtom(conversationId))
    return userIds[userIds.length - 1] === userMsgId
  })
})

// Key format: "conversationId:userMsgId" to isolate per chat
const assistantIdsCacheByChat = new Map<string, string[]>()
export const assistantIdsForUserMsgAtomFamily = atomFamily((userMsgId: string) =>
  atom((get) => {
    const groups = get(messageGroupsAtom)
    const conversationId = get(currentConversationIdAtom)
    const group = groups.find((g) => g.userMsgId === userMsgId)
    const newIds = group?.assistantMsgIds ?? []

    // Return cached array if content is the same
    const cacheKey = `${conversationId}:${userMsgId}`
    const cached = assistantIdsCacheByChat.get(cacheKey)
    if (
      cached &&
      cached.length === newIds.length &&
      cached.every((id, i) => id === newIds[i])
    ) {
      return cached
    }

    assistantIdsCacheByChat.set(cacheKey, newIds)
    return newIds
  })
)

// Is this user message the last one?
export const isLastUserMessageAtomFamily = atomFamily((userMsgId: string) =>
  atom((get) => {
    const userIds = get(userMessageIdsAtom)
    return userIds[userIds.length - 1] === userMsgId
  })
)

// Is this user message the first one? (used to hide rollback button on first message)
export const isFirstUserMessageAtomFamily = atomFamily((userMsgId: string) =>
  atom((get) => {
    const userIds = get(userMessageIdsAtom)
    return userIds[0] === userMsgId
  })
)

type RollbackLookupMessage = {
  role: MessageRole
  metadata?: Record<string, unknown>
  parts?: MessagePart[]
}

function hasCompactToolUsePart(parts?: MessagePart[]): boolean {
  return !!parts?.some((part) => part.type === "tool-Compact")
}

// Shared rollback target lookup used by both UI visibility and rollback action.
export function findRollbackTargetSdkUuidForUserIndex(
  userMsgIndex: number,
  totalMessageCount: number,
  getMessageAt: (index: number) => RollbackLookupMessage | null | undefined,
): string | null {
  if (userMsgIndex <= 0 || totalMessageCount <= 0) return null

  // 1) Pick the first assistant before this user message.
  let targetAssistantIndex = -1
  let targetAssistantMessage: RollbackLookupMessage | null | undefined = null
  for (let i = userMsgIndex - 1; i >= 0; i--) {
    const message = getMessageAt(i)
    if (!message || message.role !== "assistant") continue
    targetAssistantIndex = i
    targetAssistantMessage = message
    break
  }

  if (targetAssistantIndex === -1 || !targetAssistantMessage) return null

  // 2) Any compact after that assistant (up to the end of the dialog) means
  // this assistant is already behind compact and cannot be a rollback target.
  for (let i = targetAssistantIndex; i < totalMessageCount; i++) {
    const message = getMessageAt(i)
    if (!message || message.role !== "assistant") continue
    if (hasCompactToolUsePart(message.parts)) {
      return null
    }
  }

  // 3) No compact after target assistant: allow rollback only if target has SDK UUID.
  const sdkUuid = targetAssistantMessage.metadata?.sdkMessageUuid
  return typeof sdkUuid === "string" && sdkUuid.length > 0 ? sdkUuid : null
}

// Per-conversation rollback target for split panes.
// Key format: "conversationId:::userMsgId"
export const rollbackTargetPerChatAtomFamily = atomFamily((key: string) => {
  const sepIdx = key.indexOf(":::")
  const conversationId = key.slice(0, sepIdx)
  const userMsgId = key.slice(sepIdx + 3)
  return atom((get) => {
    const ids = get(messageIdsPerChatAtom(conversationId))
    const roles = get(messageRolesPerChatAtom(conversationId))
    const userMsgIndex = ids.indexOf(userMsgId)

    if (userMsgIndex <= 0) return null

    return findRollbackTargetSdkUuidForUserIndex(userMsgIndex, ids.length, (index) => {
      const messageId = ids[index]
      if (!messageId) return null

      const role = roles.get(messageId)
      if (!role) return null

      if (role !== "assistant") {
        return { role }
      }

      return get(messageAtomFamily(getPerChatMessageKey(conversationId, messageId)))
    })
  })
})

// SDK UUID of the assistant message that rollback should target for this user message.
// Returns null when this turn cannot be rolled back.
export const rollbackTargetSdkUuidForUserMsgAtomFamily = atomFamily((userMsgId: string) =>
  atom((get) => {
    const ids = get(messageIdsAtom)
    const roles = get(messageRolesAtom)
    const userMsgIndex = ids.indexOf(userMsgId)

    if (userMsgIndex <= 0) return null

    return findRollbackTargetSdkUuidForUserIndex(userMsgIndex, ids.length, (index) => {
      const messageId = ids[index]
      if (!messageId) return null

      const role = roles.get(messageId)
      if (!role) return null

      if (role !== "assistant") {
        return { role }
      }

      const conversationId = get(currentConversationIdAtom)
      return get(messageAtomFamily(getPerChatMessageKey(conversationId, messageId)))
    })
  })
)

// ============================================================================
// STREAMING STATUS
// ============================================================================

export const isStreamingAtom = atom((get) => {
  const status = get(chatStatusAtom)
  return status === "streaming" || status === "submitted"
})

// Has any messages
export const hasMessagesAtom = atom((get) => {
  const ids = get(messageIdsAtom)
  return ids.length > 0
})

// ============================================================================
// LAST ASSISTANT MESSAGE - For plan detection
// ============================================================================

// Cache for last assistant message to avoid re-reading on every check
// Keyed by conversationId to isolate per chat
const lastAssistantCacheByChat = new Map<string, { id: string | null; msg: Message | null }>()

export const lastAssistantMessageAtom = atom((get) => {
  const ids = get(messageIdsAtom)
  const roles = get(messageRolesAtom)
  const conversationId = get(currentConversationIdAtom)

  // Find the last assistant ID
  let lastAssistantId: string | null = null
  for (let i = ids.length - 1; i >= 0; i--) {
    if (roles.get(ids[i]!) === "assistant") {
      lastAssistantId = ids[i]!
      break
    }
  }

  const cached = lastAssistantCacheByChat.get(conversationId)

  if (!lastAssistantId) {
    lastAssistantCacheByChat.set(conversationId, { id: null, msg: null })
    return null
  }

  // If same ID, return cached message
  if (lastAssistantId === cached?.id && cached.msg) {
    // But we need to get fresh message in case it changed during streaming
    const freshMsg = get(messageAtomFamily(getPerChatMessageKey(conversationId, lastAssistantId)))
    if (freshMsg === cached.msg) {
      return cached.msg
    }
    lastAssistantCacheByChat.set(conversationId, { id: lastAssistantId, msg: freshMsg })
    return freshMsg
  }

  // Different ID, get fresh message
  const msg = get(messageAtomFamily(getPerChatMessageKey(conversationId, lastAssistantId)))
  lastAssistantCacheByChat.set(conversationId, { id: lastAssistantId, msg })
  return msg
})

// Has unapproved plan (for approve button)
export const hasUnapprovedPlanAtom = atom((get) => {
  const lastAssistant = get(lastAssistantMessageAtom)
  if (!lastAssistant) return false

  const parts = lastAssistant.parts || []
  for (const part of parts) {
    if (part.type === "tool-invocation" && part.toolName === "ExitPlanMode") {
      if (!part.result) return true
    }
  }
  return false
})

// ============================================================================
// TOKEN DATA - For input area
// ============================================================================

// Cache for token data to avoid full recalculation
// Keyed by conversationId to isolate per chat
type TokenData = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  totalTokens: number
  messageCount: number
  totalMessageCount: number
  // Track last message's output tokens to detect when streaming completes
  lastMsgOutputTokens: number
  // Track last message parts signature to detect compact boundary updates
  lastMsgPartsKey: string
}
const tokenDataCacheByChat = new Map<string, TokenData>()

export const messageTokenDataAtom = atom((get) => {
  const ids = get(messageIdsAtom)
  const conversationId = get(currentConversationIdAtom)

  // Get the last message to check if its tokens changed
  const lastId = ids[ids.length - 1]
  const lastMsg = lastId ? get(messageAtomFamily(getPerChatMessageKey(conversationId, lastId))) : null
  // Note: metadata has flat structure (metadata.outputTokens), not nested (metadata.usage.outputTokens)
  const lastMsgOutputTokens = (lastMsg?.metadata?.outputTokens as number) || 0
  const lastMsgParts = lastMsg?.parts as Array<{ type?: string; state?: string }> | undefined
  const lastPart = lastMsgParts?.[lastMsgParts.length - 1]
  const lastMsgPartsKey = `${lastMsgParts?.length ?? 0}:${lastPart?.type ?? ""}:${lastPart?.state ?? ""}`

  const cached = tokenDataCacheByChat.get(conversationId)

  // Cache is valid if:
  // 1. Message count is the same AND
  // 2. Last message's output tokens haven't changed (detects streaming completion)
  if (
    cached &&
    ids.length === cached.totalMessageCount &&
    lastMsgOutputTokens === cached.lastMsgOutputTokens &&
    lastMsgPartsKey === cached.lastMsgPartsKey
  ) {
    return cached
  }

  // Recalculate token data (since last completed compact boundary)
  let startIndex = 0
  for (let i = 0; i < ids.length; i++) {
    const msg = get(messageAtomFamily(getPerChatMessageKey(conversationId, ids[i]!)))
    const parts = msg?.parts as Array<{ type?: string; state?: string }> | undefined
    if (
      parts?.some(
        (part) =>
          part.type === "tool-Compact" &&
          (part.state === "output-available" || part.state === "result"),
      )
    ) {
      // Include the compact result itself in the token window
      startIndex = i
    }
  }

  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  let reasoningTokens = 0
  for (let i = startIndex; i < ids.length; i++) {
    const msg = get(messageAtomFamily(getPerChatMessageKey(conversationId, ids[i]!)))
    const metadata = msg?.metadata
    // Note: metadata has flat structure from transform.ts (metadata.inputTokens, metadata.outputTokens)
    // Extended fields like cacheReadInputTokens are not currently in MessageMetadata type
    if (metadata) {
      inputTokens += (metadata.inputTokens as number) || 0
      outputTokens += (metadata.outputTokens as number) || 0
      // These fields are not in current MessageMetadata but kept for future compatibility
      cacheReadTokens += (metadata.cacheReadInputTokens as number) || 0
      cacheWriteTokens += (metadata.cacheCreationInputTokens as number) || 0
      reasoningTokens += (metadata.reasoningTokens as number) || 0
    }
  }
  const messageCount = Math.max(0, ids.length - startIndex)

  const newTokenData: TokenData = {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    totalTokens: inputTokens + outputTokens,
    messageCount,
    totalMessageCount: ids.length,
    lastMsgOutputTokens,
    lastMsgPartsKey,
  }

  tokenDataCacheByChat.set(conversationId, newTokenData)
  return newTokenData
})

// ============================================================================
// SYNC WITH STATUS - Main sync function
// ============================================================================
// This is called from useChat to sync messages to the store.
// Key optimization: Only updates atoms for messages that actually changed.
// ============================================================================

// P1 IMMUTABILITY: complete fingerprint + deep clone + deep freeze.
//
// The AI SDK mutates its message objects in place, so object identity cannot
// be used to detect changes. Instead:
// 1. A COMPLETE content fingerprint (JSON of the whole message) detects every
//    change — including non-last parts and nested input/output fields that the
//    previous partial diff (last part only) silently missed.
// 2. Changed messages are stored as deep-cloned, deep-frozen snapshots, so
//    atoms always hold immutable values and downstream memoization can rely
//    on plain identity comparison. No external change-tracking caches needed.
//
// Perf note: fingerprinting JSON-stringifies every message on every sync tick.
// If profiling shows this matters on very long chats, cache fingerprints per
// source-object reference (WeakMap) and recompute only the streaming message.
const messageFingerprints = new Map<string, string>()

function deepClonePlain<T>(value: T): T {
  if (value instanceof Date) {
    return new Date(value.getTime()) as unknown as T
  }
  if (Array.isArray(value)) {
    return value.map((item) => deepClonePlain(item)) as unknown as T
  }
  if (value !== null && typeof value === "object") {
    const clone: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      clone[key] = deepClonePlain(val)
    }
    return clone as T
  }
  return value
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.freeze(value)
    for (const val of Object.values(value as Record<string, unknown>)) {
      freezeDeep(val)
    }
  }
  return value
}

export const syncMessagesWithStatusAtom = atom(
  null,
  (get, set, payload: { messages: Message[]; status: string; conversationId?: string; updateGlobal?: boolean }) => {
    const { messages, status, conversationId, updateGlobal = true } = payload

    const prevConversationId = get(currentConversationIdAtom)
    const currentConversationId = conversationId ?? prevConversationId
    let globalIdsChanged = false
    let globalRolesChanged = false

    if (updateGlobal) {
      // Update current conversationId if provided AND changed
      // Avoid unnecessary set() calls - even though Jotai won't re-render for same primitive,
      // this saves the overhead of the comparison check in subscribers
      if (conversationId && conversationId !== prevConversationId) {
        set(currentConversationIdAtom, conversationId)
      }

      // Update status only if changed
      const prevStatus = get(chatStatusAtom)
      if (status !== prevStatus) {
        set(chatStatusAtom, status)
      }
    }

    // Build new IDs list and roles map
    const newIds = messages.map((m) => m.id)
    const newRoles = new Map<string, MessageRole>()

    for (const msg of messages) {
      newRoles.set(msg.id, msg.role)
    }

    if (updateGlobal) {
      const currentIds = get(messageIdsAtom)
      const currentRoles = get(messageRolesAtom)

      // Check if IDs changed (new message added or removed)
      globalIdsChanged =
        newIds.length !== currentIds.length ||
        newIds.some((id, i) => id !== currentIds[i])

      if (globalIdsChanged) {
        set(messageIdsAtom, newIds)
      }

      // Check if roles changed
      globalRolesChanged = newRoles.size !== currentRoles.size
      if (!globalRolesChanged) {
        for (const [id, role] of newRoles) {
          if (currentRoles.get(id) !== role) {
            globalRolesChanged = true
            break
          }
        }
      }

      if (globalRolesChanged) {
        set(messageRolesAtom, newRoles)
      }
    }

    // Always update per-conversation atoms so split panes can render independently.
    const perChatIds = get(messageIdsPerChatAtom(currentConversationId))
    const perChatIdsChanged =
      newIds.length !== perChatIds.length ||
      newIds.some((id, i) => id !== perChatIds[i])

    if (perChatIdsChanged) {
      set(messageIdsPerChatAtom(currentConversationId), newIds)
    }

    const perChatRoles = get(messageRolesPerChatAtom(currentConversationId))
    let perChatRolesChanged = newRoles.size !== perChatRoles.size
    if (!perChatRolesChanged) {
      for (const [id, role] of newRoles) {
        if (perChatRoles.get(id) !== role) {
          perChatRolesChanged = true
          break
        }
      }
    }

    if (perChatRolesChanged) {
      set(messageRolesPerChatAtom(currentConversationId), newRoles)
    }

    // Update individual message atoms ONLY if they changed
    // This is the key optimization - only changed messages trigger re-renders
    // CRITICAL: AI SDK mutates objects in-place, so we MUST create a new reference
    // for Jotai to detect the change (it uses Object.is() for comparison)
    // We need to deep clone the message because:
    // 1. msg object itself is mutated in-place
    // 2. msg.parts array is mutated in-place
    // 3. Individual part objects inside parts are mutated in-place
    for (const msg of messages) {
      const messageKey = getPerChatMessageKey(currentConversationId, msg.id)
      const currentAtomValue = get(messageAtomFamily(messageKey))
      const fingerprint = JSON.stringify(msg)

      // Update the atom only when content actually changed. The fingerprint is
      // complete, so this catches every in-place mutation of the streaming
      // message (all parts, not just the last one) while skipping no-op syncs.
      if (currentAtomValue === null || messageFingerprints.get(messageKey) !== fingerprint) {
        messageFingerprints.set(messageKey, fingerprint)
        set(messageAtomFamily(messageKey), freezeDeep(deepClonePlain(msg)))
      }
    }

    // Cleanup removed message atoms to prevent memory leaks
    const newIdsSet = new Set(newIds)
    const previousIds = activeMessageIdsByChat.get(currentConversationId) ?? new Set()
    for (const oldId of previousIds) {
      if (!newIdsSet.has(oldId)) {
        // Message was removed - cleanup its atom and caches
        const messageKey = getPerChatMessageKey(currentConversationId, oldId)
        messageAtomFamily.remove(messageKey)
        messageFingerprints.delete(getPerChatMessageKey(currentConversationId, oldId))
        assistantIdsCacheByChat.delete(`${currentConversationId}:${oldId}`)
        assistantIdsPerChatCache.delete(`${currentConversationId}:::${oldId}`)
        isLastMessagePerChatAtomFamily.remove(`${currentConversationId}:::${oldId}`)
        assistantIdsPerChatAtomFamily.remove(`${currentConversationId}:::${oldId}`)
        isLastUserMessagePerChatAtomFamily.remove(`${currentConversationId}:::${oldId}`)
        rollbackTargetPerChatAtomFamily.remove(`${currentConversationId}:::${oldId}`)

        // Also clean module-level structure/text caches to prevent unbounded growth
        messageStructureCache.delete(messageKey)
        messageStructureAtomFamily.remove(messageKey)

        const partPrefix = `${messageKey}:`
        const textPartKeysToDelete: string[] = []
        for (const key of textPartCache.keys()) {
          if (key.startsWith(partPrefix)) {
            textPartKeysToDelete.push(key)
          }
        }
        for (const key of textPartKeysToDelete) {
          textPartCache.delete(key)
          textPartAtomFamily.remove(key)
        }
      }
    }

    // Update active IDs tracking
    activeMessageIdsByChat.set(currentConversationId, newIdsSet)

    // Legacy global streaming state: update only for active pane.
    if (updateGlobal) {
      if (status === "streaming" || status === "submitted") {
        const lastId = newIds[newIds.length - 1] ?? null
        set(streamingMessageIdAtom, lastId)
      } else {
        set(streamingMessageIdAtom, null)
      }
    }

  }
)

// Legacy sync atom (not used, but kept for compatibility)
export const syncMessagesAtom = atom(
  null,
  (get, set, messages: Message[]) => {
    set(syncMessagesWithStatusAtom, { messages, status: get(chatStatusAtom) })
  }
)

// ============================================================================
// CLEANUP - For clearing store when switching chats
// ============================================================================

// Clear all caches for a specific conversation (call when unmounting/switching)
export function clearConversationCaches(conversationId: string): {
  messageIds: string[]
  toolCallIds: string[]
} {
  const clearedMessageIds: string[] = []
  const clearedToolCallIds = new Set<string>()

  // Clear message atoms
  const activeIds = activeMessageIdsByChat.get(conversationId)
  if (activeIds) {
    for (const id of activeIds) {
      const messageKey = getPerChatMessageKey(conversationId, id)
      const message = appStore.get(messageAtomFamily(messageKey))
      clearedMessageIds.push(id)

      for (const part of message?.parts || []) {
        if (typeof part?.toolCallId === "string" && part.toolCallId.length > 0) {
          clearedToolCallIds.add(part.toolCallId)
        }
      }

      messageAtomFamily.remove(messageKey)
      messageFingerprints.delete(messageKey)
      assistantIdsCacheByChat.delete(`${conversationId}:${id}`)
      assistantIdsPerChatCache.delete(`${conversationId}:::${id}`)
      isLastMessagePerChatAtomFamily.remove(`${conversationId}:::${id}`)
      assistantIdsPerChatAtomFamily.remove(`${conversationId}:::${id}`)
      isLastUserMessagePerChatAtomFamily.remove(`${conversationId}:::${id}`)
      rollbackTargetPerChatAtomFamily.remove(`${conversationId}:::${id}`)

      messageStructureCache.delete(messageKey)
      messageStructureAtomFamily.remove(messageKey)

      const partPrefix = `${messageKey}:`
      const textPartKeysToDelete: string[] = []
      for (const key of textPartCache.keys()) {
        if (key.startsWith(partPrefix)) {
          textPartKeysToDelete.push(key)
        }
      }
      for (const key of textPartKeysToDelete) {
        textPartCache.delete(key)
        textPartAtomFamily.remove(key)
      }
    }
    activeMessageIdsByChat.delete(conversationId)
  }

  // Clear other caches
  userMessageIdsCacheByChat.delete(conversationId)
  userMessageIdsPerChatCache.delete(conversationId)
  messageGroupsCacheByChat.delete(conversationId)
  messageGroupsPerChatCache.delete(conversationId)
  lastAssistantCacheByChat.delete(conversationId)
  tokenDataCacheByChat.delete(conversationId)

  return {
    messageIds: clearedMessageIds,
    toolCallIds: Array.from(clearedToolCallIds),
  }
}

// Clear all caches (call on app reset/logout)
export function clearAllCaches() {
  for (const conversationId of activeMessageIdsByChat.keys()) {
    clearConversationCaches(conversationId)
  }

  const remainingStructureIds = Array.from(messageStructureCache.keys())
  for (const messageId of remainingStructureIds) {
    messageStructureAtomFamily.remove(messageId)
  }
  messageStructureCache.clear()

  const remainingTextPartKeys = Array.from(textPartCache.keys())
  for (const key of remainingTextPartKeys) {
    textPartAtomFamily.remove(key)
  }
  textPartCache.clear()
}

// ============================================================================
// TTS PLAYBACK RATE - For PlayButton
// ============================================================================
// Stored in localStorage and accessible via Jotai atom.
// This allows PlayButton to manage its own state without passing callbacks
// through props (which would break memoization).

export const PLAYBACK_SPEEDS = [1, 2, 3] as const
export type PlaybackSpeed = (typeof PLAYBACK_SPEEDS)[number]

// Atom with localStorage persistence
export const ttsPlaybackRateAtom = atom<PlaybackSpeed>(
  // Initial value from localStorage
  (() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("tts-playback-rate")
      if (saved && PLAYBACK_SPEEDS.includes(Number(saved) as PlaybackSpeed)) {
        return Number(saved) as PlaybackSpeed
      }
    }
    return 1
  })()
)

// Write atom that also persists to localStorage
export const setTtsPlaybackRateAtom = atom(
  null,
  (_get, set, rate: PlaybackSpeed) => {
    set(ttsPlaybackRateAtom, rate)
    if (typeof window !== "undefined") {
      localStorage.setItem("tts-playback-rate", String(rate))
    }
  }
)
