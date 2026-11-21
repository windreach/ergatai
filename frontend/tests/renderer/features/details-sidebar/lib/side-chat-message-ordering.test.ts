import { beforeEach, describe, expect, it } from "vitest"

import { mapSessionMessage } from "@/features/details-sidebar/lib/session-message-mapper"
import {
  getRuntimeSessionStore,
  resetRuntimeSessionStore,
} from "@/features/conversation/runtime/runtime-session-store"
import type { Message } from "@/features/agents/stores/message-store"

const CONVERSATION_ID = "conv-side-chat-ordering"

function persisted(message: Parameters<typeof mapSessionMessage>[0]): Message {
  return mapSessionMessage(message) as unknown as Message
}

describe("side chat message ordering", () => {
  beforeEach(() => {
    resetRuntimeSessionStore()
    localStorage.clear()
  })

  it("keeps a persisted user turn above the reply after a refetch race", () => {
    const store = getRuntimeSessionStore()

    // Initial persisted snapshot: two Claude Code requests and their failed
    // turns. The user's prompt and the successful reply are not here yet.
    store.setPersistedMessages(CONVERSATION_ID, [
      persisted({
        id: "agent-request-1",
        sequence: 0,
        role: "agent",
        parts: [{ type: "text", text: "first request" }],
        content: "first request",
        metadata: { messageType: "request" },
      }),
      persisted({
        id: "assistant-error-1",
        sequence: 1,
        role: "assistant",
        parts: [],
        metadata: { turnId: "turn-1", stopReason: "error" },
        turnId: "turn-1",
      }),
      persisted({
        id: "agent-request-2",
        sequence: 2,
        role: "agent",
        parts: [{ type: "text", text: "second request" }],
        content: "second request",
        metadata: { messageType: "request" },
      }),
      persisted({
        id: "assistant-error-2",
        sequence: 3,
        role: "assistant",
        parts: [],
        metadata: { turnId: "turn-2", stopReason: "error" },
        turnId: "turn-2",
      }),
    ])

    // The local transport optimistically appends the user's prompt, then the
    // live runtime projects the reply. Both receive local sequence numbers.
    store.setLocalMessages(CONVERSATION_ID, [
      {
        id: "msg_local_user",
        role: "user",
        parts: [{ type: "text", text: "你好" }],
        metadata: {
          externalMessageId: "msg_local_user",
          streamSource: "local-transport",
        },
      } as Message,
    ])
    store.setRuntimeMessages(CONVERSATION_ID, [
      {
        id: "runtime-assistant-reply",
        role: "assistant",
        parts: [{ type: "text", text: "你好！我是 Agnes。" }],
        metadata: { turnId: "turn-3", runtime: true },
      } as Message,
    ])

    // A refetch can land after the user row is durable but before the assistant
    // row is. The canonical user row still carries backend sequence 4.
    store.setPersistedMessages(CONVERSATION_ID, [
      persisted({
        id: "agent-request-1",
        sequence: 0,
        role: "agent",
        parts: [{ type: "text", text: "first request" }],
        content: "first request",
        metadata: { messageType: "request" },
      }),
      persisted({
        id: "assistant-error-1",
        sequence: 1,
        role: "assistant",
        parts: [],
        metadata: { turnId: "turn-1", stopReason: "error" },
        turnId: "turn-1",
      }),
      persisted({
        id: "agent-request-2",
        sequence: 2,
        role: "agent",
        parts: [{ type: "text", text: "second request" }],
        content: "second request",
        metadata: { messageType: "request" },
      }),
      persisted({
        id: "assistant-error-2",
        sequence: 3,
        role: "assistant",
        parts: [],
        metadata: { turnId: "turn-2", stopReason: "error" },
        turnId: "turn-2",
      }),
      persisted({
        id: "canonical-user",
        sequence: 4,
        role: "user",
        parts: [{ type: "text", text: "你好" }],
        metadata: { externalMessageId: "msg_local_user" },
      }),
    ])

    const state = store.getRuntimeState(CONVERSATION_ID)
    expect(state?.visibleMessages.map((message) => message.role)).toEqual([
      "agent",
      "assistant",
      "agent",
      "assistant",
      "user",
      "assistant",
    ])
    expect(state?.visibleMessages.at(-2)?.id).toBe("canonical-user")
  })
})
