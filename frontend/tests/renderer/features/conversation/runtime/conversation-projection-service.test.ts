import { beforeEach, describe, expect, it } from "vitest"

import {
  getConversationProjectionService,
  resetConversationProjectionService,
} from "@/features/conversation/runtime/conversation-projection-service"
import type { Message } from "@/features/agents/stores/message-store"

describe("ConversationProjectionService", () => {
  beforeEach(() => {
    resetConversationProjectionService()
  })

  it("normalizes legacy top-level turnId and runtime sequence metadata", () => {
    const message = getConversationProjectionService().normalizeRawMessage({
      id: "msg-1",
      role: "assistant",
      parts: [{ type: "text", text: "hello" }],
      turnId: "turn-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      metadata: { runtimeSequence: 7 },
    })

    expect(message.metadata).toEqual({ runtimeSequence: 7, turnId: "turn-1" })
    expect(message.sequence).toBe(7)
    expect(message.createdAt).toEqual(new Date("2026-01-01T00:00:00.000Z"))
  })

  it("collapses ephemeral projections by role and backend turnId", () => {
    const service = getConversationProjectionService()

    const runtimeMessage: Message = {
      id: "runtime-1",
      role: "assistant",
      parts: [{ type: "text", text: "runtime" }],
      metadata: { turnId: "turn-1", runtime: true },
    } as Message
    const localMessage: Message = {
      id: "assistant-local-1",
      role: "assistant",
      parts: [{ type: "text", text: "local" }],
      metadata: { turnId: "turn-1", streamSource: "local-transport" },
    } as Message

    const result = service.project({
      runtimeMessages: [runtimeMessage],
      localMessages: [localMessage],
    })

    expect(result.visibleMessages).toHaveLength(1)
    expect(result.visibleMessages[0]?.id).toBe("assistant-local-1")
  })

  it("prefers canonical persisted output for the same backend turn", () => {
    const service = getConversationProjectionService()

    const runtimeMessage: Message = {
      id: "runtime-1",
      role: "assistant",
      parts: [{ type: "text", text: "runtime" }],
      metadata: { turnId: "turn-1", runtime: true },
    } as Message
    const canonicalMessage: Message = {
      id: "msg-canonical-1",
      role: "assistant",
      parts: [{ type: "text", text: "canonical" }],
      sequence: 1,
      turnId: "turn-1",
    } as Message

    const result = service.project({
      persistedMessages: [canonicalMessage],
      runtimeMessages: [runtimeMessage],
    })

    expect(result.visibleMessages).toHaveLength(1)
    expect(result.visibleMessages[0]?.id).toBe("msg-canonical-1")
  })

  it("replaces an optimistic user message by backend externalMessageId", () => {
    const service = getConversationProjectionService()

    const optimisticUser: Message = {
      id: "msg_1000_000_0001",
      role: "user",
      parts: [{ type: "text", text: "same prompt" }],
      metadata: {
        externalMessageId: "msg_1000_000_0001",
        streamSource: "local-transport",
      },
    } as Message
    const canonicalUser: Message = {
      id: "msg-canonical-user",
      role: "user",
      parts: [{ type: "text", text: "same prompt" }],
      sequence: 2,
      metadata: { externalMessageId: "msg_1000_000_0001" },
    } as Message

    const result = service.project({
      persistedMessages: [canonicalUser],
      localMessages: [optimisticUser],
    })

    expect(result.visibleMessages).toHaveLength(1)
    expect(result.visibleMessages[0]?.id).toBe("msg-canonical-user")
  })
})
