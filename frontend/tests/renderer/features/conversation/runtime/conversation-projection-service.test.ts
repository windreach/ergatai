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

  it("memoizes projection results for identical source references", () => {    const service = getConversationProjectionService()
    const persisted: Message[] = [
      {
        id: "msg-1",
        role: "assistant",
        parts: [{ type: "text", text: "hello" }],
        sequence: 1,
        metadata: { turnId: "turn-1" },
      } as Message,
    ]

    const first = service.project({ persistedMessages: persisted })
    const second = service.project({ persistedMessages: persisted })

    expect(second).toBe(first)
    expect(second.visibleMessages).toBe(first.visibleMessages)
  })

  it("recomputes when a new array with the same length but different content is passed", () => {
    const service = getConversationProjectionService()
    const firstInput: Message[] = [
      {
        id: "msg-1",
        role: "assistant",
        parts: [{ type: "text", text: "hello" }],
        sequence: 1,
        metadata: { turnId: "turn-1" },
      } as Message,
    ]
    const secondInput: Message[] = [
      {
        id: "msg-2",
        role: "assistant",
        parts: [{ type: "text", text: "world" }],
        sequence: 1,
        metadata: { turnId: "turn-1" },
      } as Message,
    ]

    const first = service.project({ persistedMessages: firstInput })
    const second = service.project({ persistedMessages: secondInput })

    expect(second).not.toBe(first)
    expect(second.visibleMessages[0]?.id).toBe("msg-2")
  })

  it("does not return a stale projection after in-place mutation of a reused array", () => {
    const service = getConversationProjectionService()
    const persisted: Message[] = [
      {
        id: "msg-1",
        role: "assistant",
        parts: [{ type: "text", text: "hello" }],
        sequence: 1,
        metadata: { turnId: "turn-1" },
      } as Message,
    ]

    const first = service.project({ persistedMessages: persisted })
    persisted[0] = {
      id: "msg-2",
      role: "assistant",
      parts: [{ type: "text", text: "world" }],
      sequence: 1,
      metadata: { turnId: "turn-1" },
    } as Message

    const second = service.project({ persistedMessages: persisted })

    expect(second).not.toBe(first)
    expect(second.visibleMessages[0]?.id).toBe("msg-2")
  })

  it("turns a persisted failed turn into a single error part", () => {
    const message = getConversationProjectionService().normalizeRawMessage({
      id: "msg-error",
      role: "assistant",
      parts: [{ type: "text", text: "There's an issue with the selected model (qwen3.7-plus)." }],
      metadata: {
        turnId: "turn-1",
        stopReason: "error",
        error: {
          message: "There's an issue with the selected model (qwen3.7-plus).",
          errorName: "model_not_found",
          errorType: "model_not_found",
        },
      },
    })

    const parts = message.parts as Array<Record<string, unknown>>
    expect(parts).toHaveLength(1)
    expect(parts[0]?.type).toBe("error")
    expect((parts[0]?.error as { errorName?: string }).errorName).toBe("model_not_found")
    expect((parts[0]?.error as { rawText?: string }).rawText).toContain("qwen3.7-plus")
  })

  it("recognizes legacy failed turns from the top-level stopReason field", () => {
    const message = getConversationProjectionService().normalizeRawMessage({
      id: "msg-legacy-error",
      role: "assistant",
      parts: [{ type: "text", text: "There's an issue with the selected model (qwen3.7-plus)." }],
      metadata: { turnId: "turn-1" },
      stopReason: "error",
    })

    const parts = message.parts as Array<Record<string, unknown>>
    expect(parts).toHaveLength(1)
    expect(parts[0]?.type).toBe("error")
    expect((parts[0]?.error as { message?: string }).message).toContain("selected model")
  })

  it("collapses consecutive identical failed turns into one error card", () => {
    const service = getConversationProjectionService()
    const makeError = (id: string, sequence: number): Message =>
      ({
        id,
        role: "assistant",
        sequence,
        parts: [{ type: "error", error: { message: "rate limited", errorName: "rate_limit" } }],
        metadata: { turnId: `turn-${id}`, stopReason: "error" },
      }) as Message

    const result = service.project({
      persistedMessages: [makeError("msg-1", 1), makeError("msg-2", 2), makeError("msg-3", 3)],
    })

    expect(result.visibleMessages).toHaveLength(1)
    const error = (result.visibleMessages[0]?.parts?.[0] as { error?: { repeatCount?: number } }).error
    expect(error?.repeatCount).toBe(3)
  })

  it("collapses identical failed turns separated by empty turn placeholders", () => {
    const service = getConversationProjectionService()
    const makeError = (id: string, sequence: number): Message =>
      ({
        id,
        role: "assistant",
        sequence,
        parts: [
          {
            type: "error",
            error: {
              message: "rate limited",
              errorName: "rate_limit",
              rawText: "rate limited",
            },
          },
        ],
        metadata: { turnId: `turn-${id}`, stopReason: "error" },
      }) as Message
    const placeholder = {
      id: "msg-empty",
      role: "assistant",
      sequence: 2,
      parts: [],
      metadata: { turnId: "turn-empty" },
    } as Message

    const result = service.project({
      persistedMessages: [makeError("msg-1", 1), placeholder, makeError("msg-3", 3)],
    })

    const errorParts = result.visibleMessages.flatMap((message) =>
      (message.parts ?? []).filter((part) => part.type === "error"),
    )
    expect(errorParts).toHaveLength(1)
    const error = (
      errorParts[0] as { error?: { repeatCount?: number; rawText?: string } }
    ).error
    expect(error?.repeatCount).toBe(2)
    expect(error?.rawText).toBe("rate limited")
  })
})