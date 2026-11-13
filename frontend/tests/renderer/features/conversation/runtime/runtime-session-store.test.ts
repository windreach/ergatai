/**
 * Tests for Runtime Session Store
 *
 * Tests cover:
 * - Session lifecycle (create, get, release)
 * - State management (status, messages, queue)
 * - Message merging and deduplication
 * - Listener notifications
 * - Sequence persistence
 */

import { describe, it, expect, beforeEach, vi } from "vitest"
import {
  getRuntimeSessionStore,
  resetRuntimeSessionStore,
} from "@/features/conversation/runtime/runtime-session-store"
import type { Message } from "@/features/agents/stores/message-store"

describe("RuntimeSessionStore", () => {
  beforeEach(() => {
    resetRuntimeSessionStore()
    localStorage.clear()
  })

  describe("Session Lifecycle", () => {
    it("should create a new session on ensureSession()", () => {
      const store = getRuntimeSessionStore()
      const session = store.ensureSession("conv-1")

      expect(session).toBeDefined()
      expect(session.conversationId).toBe("conv-1")
      expect(session.status).toBe("idle")
      expect(session.persistedMessages).toEqual([])
      expect(session.runtimeMessages).toEqual([])
      expect(session.visibleMessages).toEqual([])
      expect(session.queue).toEqual([])
    })

    it("should return existing session on subsequent ensureSession() calls", () => {
      const store = getRuntimeSessionStore()
      const session1 = store.ensureSession("conv-1")
      const session2 = store.ensureSession("conv-1")

      expect(session1).toBe(session2)
    })

    it("should return null for non-existent session in getSession()", () => {
      const store = getRuntimeSessionStore()
      const session = store.getSession("non-existent")

      expect(session).toBeNull()
    })

    it("should remove session on releaseSession()", () => {
      const store = getRuntimeSessionStore()
      store.ensureSession("conv-1")
      store.releaseSession("conv-1")

      const session = store.getSession("conv-1")
      expect(session).toBeNull()
    })

    it("should handle multiple independent sessions", () => {
      const store = getRuntimeSessionStore()
      store.ensureSession("conv-1")
      store.ensureSession("conv-2")

      const session1 = store.getSession("conv-1")
      const session2 = store.getSession("conv-2")

      expect(session1).not.toBeNull()
      expect(session2).not.toBeNull()
      expect(session1?.conversationId).toBe("conv-1")
      expect(session2?.conversationId).toBe("conv-2")
    })
  })

  describe("Status Management", () => {
    it("should update session status", () => {
      const store = getRuntimeSessionStore()
      store.ensureSession("conv-1")
      store.setStatus("conv-1", "streaming")

      const state = store.getRuntimeState("conv-1")
      expect(state?.status).toBe("streaming")
      expect(state?.isStreaming).toBe(true)
    })

    it("should transition through multiple statuses", () => {
      const store = getRuntimeSessionStore()
      store.ensureSession("conv-1")

      store.setStatus("conv-1", "ready")
      expect(store.getRuntimeState("conv-1")?.status).toBe("ready")

      store.setStatus("conv-1", "streaming")
      expect(store.getRuntimeState("conv-1")?.status).toBe("streaming")

      store.setStatus("conv-1", "completed")
      expect(store.getRuntimeState("conv-1")?.status).toBe("completed")
    })
  })

  describe("Message Management", () => {
    it("should set persisted messages", () => {
      const store = getRuntimeSessionStore()
      store.ensureSession("conv-1")

      const messages: Message[] = [
        {
          id: "msg-1",
          role: "user",
          content: [{ type: "text", text: "Hello" }],
          createdAt: new Date("2024-01-01T00:00:00Z"),
        } as Message,
      ]

      store.setPersistedMessages("conv-1", messages)

      const state = store.getRuntimeState("conv-1")
      expect(state?.persistedMessages).toHaveLength(1)
      expect(state?.visibleMessages).toHaveLength(1)
    })

    it("should not notify when runtime messages are structurally unchanged", () => {
      const store = getRuntimeSessionStore()
      store.ensureSession("conv-1")

      const listener = vi.fn()
      const unsubscribe = store.subscribe("conv-1", listener)

      const message: Message = {
        id: "msg-1",
        role: "assistant",
        parts: [{ type: "text", text: "Hello" }],
        metadata: { turn: 1 },
      } as Message

      store.setRuntimeMessages("conv-1", [message])
      expect(listener).toHaveBeenCalledTimes(1)

      // A recreated array is common when a component projects the store back
      // into itself. It must not create another state snapshot.
      store.setRuntimeMessages("conv-1", [{ ...message }])
      expect(listener).toHaveBeenCalledTimes(1)

      unsubscribe()
    })

    it("should add runtime messages with sequence numbers", () => {
      const store = getRuntimeSessionStore()
      store.ensureSession("conv-1")

      const message: Message = {
        id: "msg-1",
        role: "assistant",
        content: [{ type: "text", text: "Hi" }],
      } as Message

      store.addRuntimeMessage("conv-1", message)

      const state = store.getRuntimeState("conv-1")
      expect(state?.runtimeMessages).toHaveLength(1)
      expect(state?.runtimeMessages[0]?.sequence).toBe(1)
    })

    it("should merge persisted and runtime messages with deduplication", () => {
      const store = getRuntimeSessionStore()
      store.ensureSession("conv-1")

      const persistedMsg: Message = {
        id: "msg-1",
        role: "user",
        content: [{ type: "text", text: "Original" }],
        createdAt: new Date("2024-01-01T00:00:00Z"),
      } as Message

      const runtimeMsg: Message = {
        id: "msg-1",
        role: "user",
        content: [{ type: "text", text: "Updated" }],
      } as Message

      store.setPersistedMessages("conv-1", [persistedMsg])
      store.setRuntimeMessages("conv-1", [runtimeMsg])

      const state = store.getRuntimeState("conv-1")
      expect(state?.visibleMessages).toHaveLength(1)
      // Runtime message should override persisted
      expect(state?.visibleMessages[0]?.content[0]).toEqual({
        type: "text",
        text: "Updated",
      })
    })

    it("should merge source channels and let local transport override live backend turns", () => {
      const store = getRuntimeSessionStore()
      store.ensureSession("conv-1")

      const persistedMessage: Message = {
        id: "durable-1",
        role: "user",
        parts: [{ type: "text", text: "Durable user" }],
        sequence: 0,
      } as Message
      const backendMessage: Message = {
        id: "live-1",
        role: "assistant",
        parts: [{ type: "text", text: "Backend preview" }],
      } as Message
      const localMessage: Message = {
        id: "live-1",
        role: "assistant",
        parts: [{ type: "text", text: "Local stream" }],
      } as Message

      store.setPersistedMessages("conv-1", [persistedMessage])
      store.setRuntimeMessages("conv-1", [backendMessage])
      store.setLocalMessages("conv-1", [localMessage])

      const state = store.getRuntimeState("conv-1")
      expect(state?.visibleMessages.map((message) => message.id)).toEqual([
        "durable-1",
        "live-1",
      ])
      expect(state?.visibleMessages[1]?.parts).toEqual([
        { type: "text", text: "Local stream" },
      ])

      // Clearing a source removes only that source's messages.
      store.setRuntimeMessages("conv-1", [])
      expect(store.getRuntimeState("conv-1")?.runtimeMessages).toHaveLength(0)
      expect(store.getRuntimeState("conv-1")?.localMessages).toHaveLength(1)
      expect(store.getRuntimeState("conv-1")?.visibleMessages.map((message) => message.id)).toEqual([
        "durable-1",
        "live-1",
      ])
    })

    it("keeps the previous live turn visible when the next turn starts before persistence lands", () => {
      const store = getRuntimeSessionStore()
      store.ensureSession("conv-1")

      const userMessage: Message = {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Question" }],
        sequence: 0,
      } as Message
      const turn1: Message = {
        id: "runtime-conv-1-turn-1-0",
        role: "assistant",
        parts: [{ type: "text", text: "First turn" }],
        metadata: { turnId: "turn-1", runtime: true },
      } as Message
      const turn2: Message = {
        id: "runtime-conv-1-turn-2-0",
        role: "assistant",
        parts: [{ type: "text", text: "Second turn" }],
        metadata: { turnId: "turn-2", runtime: true },
      } as Message

      store.setPersistedMessages("conv-1", [userMessage])
      store.setRuntimeMessages("conv-1", [turn1])
      store.setRuntimeMessages("conv-1", [turn2])

      let state = store.getRuntimeState("conv-1")
      expect(state?.runtimeMessages.map((message) => message.id)).toEqual([
        "runtime-conv-1-turn-1-0",
        "runtime-conv-1-turn-2-0",
      ])

      // Canonical turn-1 replaces the retained live projection; turn-2 stays
      // live until its own durable copy arrives.
      const canonicalTurn1: Message = {
        id: "msg-canonical-1",
        role: "assistant",
        parts: [{ type: "text", text: "First turn (persisted)" }],
        metadata: { turnId: "turn-1" },
        sequence: 1,
      } as Message
      store.setPersistedMessages("conv-1", [userMessage, canonicalTurn1])

      state = store.getRuntimeState("conv-1")
      expect(state?.runtimeMessages.map((message) => message.id)).toEqual([
        "runtime-conv-1-turn-2-0",
      ])
      expect(state?.visibleMessages.map((message) => message.id)).toEqual([
        "user-1",
        "msg-canonical-1",
        "runtime-conv-1-turn-2-0",
      ])
    })

    it("should collapse different assistant projections by the backend turn id", () => {
      const store = getRuntimeSessionStore()
      store.ensureSession("conv-1")

      const userMessage: Message = {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Question" }],
        sequence: 0,
      } as Message
      const backendMessage: Message = {
        id: "runtime-conv-1-turn-1-0",
        role: "assistant",
        parts: [{ type: "text", text: "Runtime projection" }],
        metadata: { turnId: "turn-1", runtime: true },
      } as Message
      const localMessage: Message = {
        id: "assistant-local-1",
        role: "assistant",
        parts: [{ type: "text", text: "Local projection" }],
        metadata: { turnId: "turn-1", streamSource: "local-transport" },
      } as Message

      store.setPersistedMessages("conv-1", [userMessage])
      store.setRuntimeMessages("conv-1", [backendMessage])
      store.setLocalMessages("conv-1", [localMessage])

      expect(
        store.getRuntimeState("conv-1")?.visibleMessages.map((message) => message.id),
      ).toEqual(["user-1", "assistant-local-1"])
    })

    it("should prefer canonical persisted output for a completed backend turn", () => {
      const store = getRuntimeSessionStore()
      store.ensureSession("conv-1")

      const runtimeMessage: Message = {
        id: "runtime-conv-1-turn-1-0",
        role: "assistant",
        parts: [{ type: "text", text: "Runtime projection" }],
        metadata: { turnId: "turn-1", runtime: true },
      } as Message
      const canonicalMessage: Message = {
        id: "msg-canonical-1",
        role: "assistant",
        parts: [{ type: "text", text: "Canonical output" }],
        sequence: 1,
        turnId: "turn-1",
      } as Message

      store.setRuntimeMessages("conv-1", [runtimeMessage])
      store.setPersistedMessages("conv-1", [canonicalMessage])

      expect(
        store.getRuntimeState("conv-1")?.visibleMessages.map((message) => message.id),
      ).toEqual(["msg-canonical-1"])
    })

    it("should sort messages by sequence number", () => {
      const store = getRuntimeSessionStore()
      store.ensureSession("conv-1")

      const msg1: Message = {
        id: "msg-1",
        role: "user",
        content: [{ type: "text", text: "First" }],
      } as Message

      const msg2: Message = {
        id: "msg-2",
        role: "assistant",
        content: [{ type: "text", text: "Second" }],
      } as Message

      store.addRuntimeMessage("conv-1", msg1)
      store.addRuntimeMessage("conv-1", msg2)

      const state = store.getRuntimeState("conv-1")
      expect(state?.runtimeMessages[0]?.id).toBe("msg-1")
      expect(state?.runtimeMessages[0]?.sequence).toBe(1)
      expect(state?.runtimeMessages[1]?.id).toBe("msg-2")
      expect(state?.runtimeMessages[1]?.sequence).toBe(2)
    })

    it("should update runtime message", () => {
      const store = getRuntimeSessionStore()
      store.ensureSession("conv-1")

      const message: Message = {
        id: "msg-1",
        role: "assistant",
        content: [{ type: "text", text: "Original" }],
      } as Message

      store.addRuntimeMessage("conv-1", message)
      store.updateRuntimeMessage("conv-1", "msg-1", (msg) => ({
        ...msg,
        content: [{ type: "text", text: "Updated" }],
      }))

      const state = store.getRuntimeState("conv-1")
      expect(state?.runtimeMessages[0]?.content[0]).toEqual({
        type: "text",
        text: "Updated",
      })
    })
  })

  describe("Queue Management", () => {
    it("should add queue item", () => {
      const store = getRuntimeSessionStore()
      store.ensureSession("conv-1")

      const queueItem = {
        id: "queue-1",
        originalInput: {} as any,
        status: "pending" as const,
        queuedAt: new Date(),
      }

      store.addQueueItem("conv-1", queueItem)

      const state = store.getRuntimeState("conv-1")
      expect(state?.queue).toHaveLength(1)
      expect(state?.queue[0]?.id).toBe("queue-1")
    })

    it("should remove queue item", () => {
      const store = getRuntimeSessionStore()
      store.ensureSession("conv-1")

      const queueItem = {
        id: "queue-1",
        originalInput: {} as any,
        status: "pending" as const,
        queuedAt: new Date(),
      }

      store.addQueueItem("conv-1", queueItem)
      store.removeQueueItem("conv-1", "queue-1")

      const state = store.getRuntimeState("conv-1")
      expect(state?.queue).toHaveLength(0)
    })

    it("should update queue item", () => {
      const store = getRuntimeSessionStore()
      store.ensureSession("conv-1")

      const queueItem = {
        id: "queue-1",
        originalInput: {} as any,
        status: "pending" as const,
        queuedAt: new Date(),
      }

      store.addQueueItem("conv-1", queueItem)
      store.updateQueueItem("conv-1", "queue-1", (item) => ({
        ...item,
        status: "sending" as const,
      }))

      const state = store.getRuntimeState("conv-1")
      expect(state?.queue[0]?.status).toBe("sending")
    })
  })

  describe("Turn ID Management", () => {
    it("should set and get current turn ID", () => {
      const store = getRuntimeSessionStore()
      store.ensureSession("conv-1")

      store.setCurrentTurnId("conv-1", "turn-123")

      const turnId = store.getCurrentTurnId("conv-1")
      expect(turnId).toBe("turn-123")
    })

    it("should clear current turn ID", () => {
      const store = getRuntimeSessionStore()
      store.ensureSession("conv-1")

      store.setCurrentTurnId("conv-1", "turn-123")
      store.setCurrentTurnId("conv-1", null)

      const turnId = store.getCurrentTurnId("conv-1")
      expect(turnId).toBeNull()
    })
  })

  describe("Sequence Persistence", () => {
    it("should persist sequence to localStorage", () => {
      const store = getRuntimeSessionStore()
      store.ensureSession("conv-1")

      store.incrementLocalSequence("conv-1")

      const stored = localStorage.getItem("ergatai:runtime:sequence:conv-1")
      expect(stored).toBe("1")
    })

    it("should restore sequence from localStorage on session creation", () => {
      localStorage.setItem("ergatai:runtime:sequence:conv-1", "42")

      const store = getRuntimeSessionStore()
      const session = store.ensureSession("conv-1")

      expect(session.lastRuntimeSequence).toBe(42)
      expect(session.localSequence).toBe(42)
    })

    it("should clean up localStorage on releaseSession()", () => {
      const store = getRuntimeSessionStore()
      store.ensureSession("conv-1")
      store.incrementLocalSequence("conv-1")

      store.releaseSession("conv-1")

      const stored = localStorage.getItem("ergatai:runtime:sequence:conv-1")
      expect(stored).toBeNull()
    })
  })

  describe("Listener Notifications", () => {
    it("should notify listeners on status change", () => {
      const store = getRuntimeSessionStore()
      store.ensureSession("conv-1")

      const listener = vi.fn()
      store.subscribe("conv-1", listener)

      store.setStatus("conv-1", "streaming")

      expect(listener).toHaveBeenCalledTimes(1)
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "streaming",
        })
      )
    })

    it("should notify listeners on message add", () => {
      const store = getRuntimeSessionStore()
      store.ensureSession("conv-1")

      const listener = vi.fn()
      store.subscribe("conv-1", listener)

      const message: Message = {
        id: "msg-1",
        role: "assistant",
        content: [{ type: "text", text: "Hi" }],
      } as Message

      store.addRuntimeMessage("conv-1", message)

      expect(listener).toHaveBeenCalledTimes(1)
    })

    it("should unsubscribe listener", () => {
      const store = getRuntimeSessionStore()
      store.ensureSession("conv-1")

      const listener = vi.fn()
      const unsubscribe = store.subscribe("conv-1", listener)

      unsubscribe()
      store.setStatus("conv-1", "streaming")

      expect(listener).not.toHaveBeenCalled()
    })

    it("should handle listener errors gracefully", () => {
      const store = getRuntimeSessionStore()
      store.ensureSession("conv-1")

      const errorListener = vi.fn(() => {
        throw new Error("Listener error")
      })
      const normalListener = vi.fn()

      store.subscribe("conv-1", errorListener)
      store.subscribe("conv-1", normalListener)

      // Should not throw
      store.setStatus("conv-1", "streaming")

      expect(errorListener).toHaveBeenCalled()
      expect(normalListener).toHaveBeenCalled()
    })
  })

  describe("Runtime State", () => {
    it("should return null for non-existent session", () => {
      const store = getRuntimeSessionStore()
      const state = store.getRuntimeState("non-existent")

      expect(state).toBeNull()
    })

    it("should return cached state for stable snapshots", () => {
      const store = getRuntimeSessionStore()
      store.ensureSession("conv-1")

      const state1 = store.getRuntimeState("conv-1")
      const state2 = store.getRuntimeState("conv-1")

      // Should return the same object reference (cached)
      expect(state1).toBe(state2)
    })

    it("should invalidate cache on state change", () => {
      const store = getRuntimeSessionStore()
      store.ensureSession("conv-1")

      const state1 = store.getRuntimeState("conv-1")
      store.setStatus("conv-1", "streaming")
      const state2 = store.getRuntimeState("conv-1")

      // Should return different object references after state change
      expect(state1).not.toBe(state2)
    })

    it("should compute isStreaming correctly", () => {
      const store = getRuntimeSessionStore()
      store.ensureSession("conv-1")

      store.setStatus("conv-1", "streaming")
      expect(store.getRuntimeState("conv-1")?.isStreaming).toBe(true)

      store.setStatus("conv-1", "ready")
      expect(store.getRuntimeState("conv-1")?.isStreaming).toBe(false)
    })
  })

  describe("Error Management", () => {
    it("should set and clear error", () => {
      const store = getRuntimeSessionStore()
      store.ensureSession("conv-1")

      const error = {
        code: "SEND_FAILED",
        message: "Failed to send",
        timestamp: new Date(),
      }

      store.setError("conv-1", error)
      expect(store.getRuntimeState("conv-1")?.error).toEqual(error)

      store.setError("conv-1", null)
      expect(store.getRuntimeState("conv-1")?.error).toBeUndefined()
    })
  })
})

describe("Cached public state", () => {
  it("returns the same snapshot reference until a mutation occurs", () => {
    const store = getRuntimeSessionStore()
    store.ensureSession("conv-cache")

    const first = store.getRuntimeState("conv-cache")
    const second = store.getRuntimeState("conv-cache")

    expect(second).toBe(first)
  })

  it("returns a new snapshot reference after a mutation", () => {
    const store = getRuntimeSessionStore()
    store.ensureSession("conv-cache")

    const before = store.getRuntimeState("conv-cache")
    store.setStatus("conv-cache", "streaming")
    const after = store.getRuntimeState("conv-cache")

    expect(after).not.toBe(before)
    expect(after?.status).toBe("streaming")
  })

  it("returns a new snapshot reference after message ingestion", () => {
    const store = getRuntimeSessionStore()
    store.ensureSession("conv-cache")

    const before = store.getRuntimeState("conv-cache")
    store.setPersistedMessages("conv-cache", [
      { id: "m1", role: "assistant", parts: [{ type: "text", text: "hi" }] } as Message,
    ])
    const after = store.getRuntimeState("conv-cache")

    expect(after).not.toBe(before)
    expect(after?.visibleMessages).toHaveLength(1)
  })
})

describe("Persisted snapshot staleness guard", () => {
  it("ignores a shorter persisted snapshot that is an identical prefix", () => {
    const store = getRuntimeSessionStore()
    store.ensureSession("conv-stale")

    const m1 = {
      id: "m1",
      role: "assistant",
      parts: [{ type: "text", text: "a" }],
      metadata: {},
      sequence: 1,
    } as Message
    const m2 = {
      id: "m2",
      role: "assistant",
      parts: [{ type: "text", text: "b" }],
      metadata: {},
      sequence: 2,
    } as Message

    store.setPersistedMessages("conv-stale", [m1, m2])
    store.setPersistedMessages("conv-stale", [m1])

    const state = store.getRuntimeState("conv-stale")
    expect(state?.visibleMessages).toHaveLength(2)
  })

  it("applies a shorter persisted snapshot when content changed", () => {
    const store = getRuntimeSessionStore()
    store.ensureSession("conv-stale")

    const m1 = {
      id: "m1",
      role: "assistant",
      parts: [{ type: "text", text: "a" }],
      sequence: 1,
    } as Message
    const m1Updated = {
      id: "m1",
      role: "assistant",
      parts: [{ type: "text", text: "a-updated" }],
      metadata: {},
      sequence: 1,
    } as Message

    store.setPersistedMessages("conv-stale", [m1])
    store.setPersistedMessages("conv-stale", [m1Updated])

    const state = store.getRuntimeState("conv-stale")
    expect(state?.visibleMessages).toHaveLength(1)
    expect(state?.visibleMessages[0]?.parts?.[0]).toMatchObject({ text: "a-updated" })
  })
})
