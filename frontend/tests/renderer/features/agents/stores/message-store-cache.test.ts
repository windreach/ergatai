import { describe, expect, it, beforeEach } from "vitest"

import {
  messageAtomFamily,
  getPerChatMessageKey,
  syncMessagesWithStatusAtom,
  userMessageIdsAtom,
  userMessageIdsPerChatAtom,
  messageGroupsAtom,
  messageGroupsPerChatAtom,
  assistantIdsForUserMsgAtomFamily,
  assistantIdsPerChatAtomFamily,
  currentConversationIdAtom,
  type Message,
} from "../../../../../src/renderer/features/agents/stores/message-store"
import { appStore } from "../../../../../src/renderer/lib/jotai-store"

const CONVERSATION_ID = "conv-cache-test"

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "m1",
    role: "assistant",
    parts: [{ type: "text", text: "hello" }],
    metadata: { tokens: 10 },
    ...overrides,
  }
}

function sync(messages: Message[], conversationId = CONVERSATION_ID, updateGlobal = true) {
  appStore.set(syncMessagesWithStatusAtom, {
    messages,
    status: "ready",
    conversationId,
    updateGlobal,
  })
}

describe("message store cache reuse", () => {
  beforeEach(() => {
    appStore.set(syncMessagesWithStatusAtom, {
      messages: [],
      status: "ready",
      conversationId: CONVERSATION_ID,
      updateGlobal: true,
    })
    appStore.set(currentConversationIdAtom, CONVERSATION_ID)
  })

  it("reuses userMessageIdsAtom reference when ids are unchanged", () => {
    const messages = [
      makeMessage({ id: "u1", role: "user" }),
      makeMessage({ id: "a1", role: "assistant" }),
    ]
    sync(messages)
    const first = appStore.get(userMessageIdsAtom)

    // New object identities, same ids -> should reuse cached array.
    sync(messages.map((m) => ({ ...m, parts: [...(m.parts ?? [])] })))
    const second = appStore.get(userMessageIdsAtom)

    expect(second).toBe(first)
  })

  it("reuses userMessageIdsPerChatAtom reference when ids are unchanged", () => {
    const messages = [
      makeMessage({ id: "u1", role: "user" }),
      makeMessage({ id: "a1", role: "assistant" }),
    ]
    sync(messages, CONVERSATION_ID, false)
    const first = appStore.get(userMessageIdsPerChatAtom(CONVERSATION_ID))

    sync(messages.map((m) => ({ ...m })), CONVERSATION_ID, false)
    const second = appStore.get(userMessageIdsPerChatAtom(CONVERSATION_ID))

    expect(second).toBe(first)
  })

  it("reuses messageGroupsAtom reference when groups are unchanged", () => {
    const messages = [
      makeMessage({ id: "u1", role: "user" }),
      makeMessage({ id: "a1", role: "assistant" }),
    ]
    sync(messages)
    const first = appStore.get(messageGroupsAtom)

    sync(messages.map((m) => ({ ...m })))
    const second = appStore.get(messageGroupsAtom)

    expect(second).toBe(first)
  })

  it("reuses messageGroupsPerChatAtom reference when groups are unchanged", () => {
    const messages = [
      makeMessage({ id: "u1", role: "user" }),
      makeMessage({ id: "a1", role: "assistant" }),
    ]
    sync(messages, CONVERSATION_ID, false)
    const first = appStore.get(messageGroupsPerChatAtom(CONVERSATION_ID))

    sync(messages.map((m) => ({ ...m })), CONVERSATION_ID, false)
    const second = appStore.get(messageGroupsPerChatAtom(CONVERSATION_ID))

    expect(second).toBe(first)
  })

  it("reuses assistantIdsForUserMsgAtomFamily reference when ids are unchanged", () => {
    const messages = [
      makeMessage({ id: "u1", role: "user" }),
      makeMessage({ id: "a1", role: "assistant" }),
    ]
    sync(messages)
    const first = appStore.get(assistantIdsForUserMsgAtomFamily("u1"))

    sync(messages.map((m) => ({ ...m })))
    const second = appStore.get(assistantIdsForUserMsgAtomFamily("u1"))

    expect(second).toBe(first)
  })

  it("reuses assistantIdsPerChatAtomFamily reference when ids are unchanged", () => {
    const messages = [
      makeMessage({ id: "u1", role: "user" }),
      makeMessage({ id: "a1", role: "assistant" }),
    ]
    sync(messages, CONVERSATION_ID, false)
    const key = `${CONVERSATION_ID}:::u1`
    const first = appStore.get(assistantIdsPerChatAtomFamily(key))

    sync(messages.map((m) => ({ ...m })), CONVERSATION_ID, false)
    const second = appStore.get(assistantIdsPerChatAtomFamily(key))

    expect(second).toBe(first)
  })
})
