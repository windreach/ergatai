"use client"

import { useEffect } from "react"
import { appStore } from "../../../lib/jotai-store"
import {
  messageAtomFamily,
  getPerChatMessageKey,
  messageIdsPerChatAtom,
  messageRolesPerChatAtom,
  type Message,
} from "../stores/message-store"
import { subscribeConversationRuntime } from "../../details-sidebar"

/**
 * Sync external-agent replies (role "respagent") from the host conversation's
 * runtime stream into the main chat's message store, so they are rendered as
 * native messages in correct sequence order instead of via a separate async
 * bridge. Initial data already arrives through the main conversation history
 * load; this hook only handles live updates.
 */
export function useHostReplySync(conversationId: string | undefined) {
  useEffect(() => {
    if (!conversationId) return

    const unsubscribe = subscribeConversationRuntime(conversationId, (state) => {
      for (const entry of state.events ?? []) {
        const event = entry.event as {
          type?: string
          role?: string | null
          message_type?: string | null
          content?: string
          parts?: unknown
          metadata?: unknown
          timestamp_ms?: number
          sender_agent_id?: string | null
          sender_agent_name?: string | null
          message_id?: string | null
        } | null
        if (!event || event.type !== "conversation_message") continue

        const messageId = event.message_id
        if (typeof messageId !== "string" || !messageId) continue

        const hasExternalId =
          typeof event.metadata === "object" &&
          event.metadata !== null &&
          typeof (event.metadata as Record<string, unknown>).externalMessageId === "string" &&
          ((event.metadata as Record<string, unknown>).externalMessageId as string).length > 0

        const isReply =
          event.role === "respagent" ||
          (event.message_type === "response" && hasExternalId)
        if (!isReply) continue

        const key = getPerChatMessageKey(conversationId, messageId)
        const existing = appStore.get(messageAtomFamily(key))
        if (existing) continue // already in store (initial load or prior sync)

        const parts =
          Array.isArray(event.parts) && (event.parts as unknown[]).length > 0
            ? (event.parts as Message["parts"])
            : [{ type: "text", text: event.content ?? "" }]

        const eventMetadata = (event.metadata as Record<string, unknown>) ?? {}
        const msg: Message = {
          id: messageId,
          role: "respagent",
          conversationId,
          sequence: entry.sequence,
          parts,
          metadata: {
            ...eventMetadata,
            senderAgentId: event.sender_agent_id ?? eventMetadata.senderAgentId,
            senderAgentName: event.sender_agent_name ?? eventMetadata.senderAgentName,
            messageType: event.message_type ?? eventMetadata.messageType,
          },
          createdAt: new Date(event.timestamp_ms ?? Date.now()),
          messageType: event.message_type ?? null,
        }

        appStore.set(messageAtomFamily(key), msg)

        const currentIds = appStore.get(messageIdsPerChatAtom(conversationId))
        if (!currentIds.includes(messageId)) {
          appStore.set(messageIdsPerChatAtom(conversationId), [...currentIds, messageId])
        }

        const roles = appStore.get(messageRolesPerChatAtom(conversationId)) as Map<string, import("../stores/message-store").MessageRole>
        if (!roles.has(messageId)) {
          const newRoles = new Map(roles)
          newRoles.set(messageId, "respagent")
          appStore.set(messageRolesPerChatAtom(conversationId), newRoles)
        }
      }
    })

    return () => {
      unsubscribe()
    }
  }, [conversationId])
}