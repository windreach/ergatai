/**
 * Tests for Conversation Runtime Gateway
 *
 * Tests cover:
 * - Subscription lifecycle (subscribe, unsubscribe)
 * - Event handling (snapshots, incremental events)
 * - Sequence persistence integration
 * - Reconnection logic
 * - State management
 * - Error handling
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest"

// Use vi.hoisted() to define mocks that can be accessed in vi.mock factory
const { mocks } = vi.hoisted(() => ({
  mocks: {
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
  },
}))

// Mock trpc before any imports to prevent electronTRPC initialization errors
vi.mock("@/lib/trpc", () => ({
  trpc: {},
  trpcClient: {
    ergatai: {
      subscribeConversationRuntime: {
        subscribe: mocks.subscribe,
      },
    },
  },
}))

vi.mock("@/lib/ipc-link", () => ({
  ipcLink: vi.fn(),
}))

import {
  subscribeConversationRuntime,
  getConversationRuntimeState,
} from "@/features/details-sidebar/lib/conversation-runtime-gateway"

describe("ConversationRuntimeGateway", () => {
  let testCounter = 0

  function getTestConversationId(): string {
    testCounter++
    return `conv-test-${testCounter}-${Date.now()}`
  }

  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
    mocks.subscribe.mockReturnValue({ unsubscribe: mocks.unsubscribe })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe("subscribeConversationRuntime", () => {
    it("should create a subscription and return unsubscribe function", () => {
      const convId = getTestConversationId()
      const listener = vi.fn()
      const unsubscribe = subscribeConversationRuntime(convId, listener)

      expect(typeof unsubscribe).toBe("function")
      expect(mocks.subscribe).toHaveBeenCalledWith(
        { conversationId: convId, afterSequence: undefined },
        expect.objectContaining({
          onData: expect.any(Function),
          onError: expect.any(Function),
          onComplete: expect.any(Function),
        })
      )
    })

    it("should call listener immediately with initial state", () => {
      const convId = getTestConversationId()
      const listener = vi.fn()
      subscribeConversationRuntime(convId, listener)

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: convId,
          status: "idle",
          connectionStatus: "connecting",
          events: [],
        })
      )
    })

    it("should restore lastSequence from localStorage", () => {
      const convId = getTestConversationId()
      // Set localStorage before subscribing
      localStorage.setItem(`ergatai:runtime:sequence:${convId}`, "42")
      const listener = vi.fn()

      subscribeConversationRuntime(convId, listener)

      // The channel should restore the lastSequence from localStorage
      const state = getConversationRuntimeState(convId)
      expect(state?.lastSequence).toBe(42)

      // But afterSequence is only sent if epoch exists (which it doesn't for new channels)
      const subscribeCall = mocks.subscribe.mock.calls[0]
      expect(subscribeCall[0].afterSequence).toBeUndefined()
    })

    it("should reuse existing channel for same conversationId", () => {
      const convId = getTestConversationId()
      const listener1 = vi.fn()
      const listener2 = vi.fn()

      subscribeConversationRuntime(convId, listener1)
      subscribeConversationRuntime(convId, listener2)

      // Should only subscribe once
      expect(mocks.subscribe).toHaveBeenCalledTimes(1)
    })

    it("should handle unsubscribe correctly", () => {
      const convId = getTestConversationId()
      const listener = vi.fn()
      const unsubscribe = subscribeConversationRuntime(convId, listener)

      unsubscribe()

      // Should not immediately unsubscribe (has delay)
      expect(mocks.unsubscribe).not.toHaveBeenCalled()
    })
  })

  describe("Event handling", () => {
    it("should handle snapshot messages", () => {
      const convId = getTestConversationId()
      const listener = vi.fn()
      subscribeConversationRuntime(convId, listener)

      const subscribeCall = mocks.subscribe.mock.calls[0]
      const options = subscribeCall[1]

      const snapshot = {
        kind: "snapshot",
        snapshot: {
          epoch: "epoch-1",
          turnId: "turn-1",
          status: "streaming",
          lastSequence: 0,
          firstSequence: 1,
          events: [
            {
              conversationId: convId,
              turnId: "turn-1",
              sequence: 1,
              timestampMs: 1000,
              event: { type: "thinking", role: "assistant" },
            },
          ],
          startedAtMs: 1000,
          updatedAtMs: 2000,
        },
      }

      options.onData(snapshot)

      const state = getConversationRuntimeState(convId)
      expect(state).toBeDefined()
      expect(state?.status).toBe("streaming")
      expect(state?.lastSequence).toBe(1)
      expect(state?.events).toHaveLength(1)

      // Should persist sequence
      const stored = localStorage.getItem(`ergatai:runtime:sequence:${convId}`)
      expect(stored).toBe("1")
    })

    it("should handle incremental event messages", () => {
      const convId = getTestConversationId()
      const listener = vi.fn()
      subscribeConversationRuntime(convId, listener)

      const subscribeCall = mocks.subscribe.mock.calls[0]
      const options = subscribeCall[1]

      // First, establish a turn with a new turnId
      const newTurnEvent = {
        kind: "event",
        event: {
          conversationId: convId,
          turnId: "turn-1",
          sequence: 1,
          timestampMs: 1000,
          event: { type: "thinking", role: "assistant" },
        },
      }

      options.onData(newTurnEvent)

      const state = getConversationRuntimeState(convId)
      expect(state?.turnId).toBe("turn-1")
      expect(state?.lastSequence).toBe(1)
      expect(state?.events).toHaveLength(1)

      // Should persist sequence
      const stored = localStorage.getItem(`ergatai:runtime:sequence:${convId}`)
      expect(stored).toBe("1")
    })

    it("should ignore events with old sequence numbers", () => {
      const convId = getTestConversationId()
      const listener = vi.fn()
      subscribeConversationRuntime(convId, listener)

      const subscribeCall = mocks.subscribe.mock.calls[0]
      const options = subscribeCall[1]

      // First event
      options.onData({
        kind: "event",
        event: {
          conversationId: convId,
          turnId: "turn-1",
          sequence: 5,
          timestampMs: 1000,
          event: { type: "thinking" },
        },
      })

      // Old event (should be ignored)
      options.onData({
        kind: "event",
        event: {
          conversationId: convId,
          turnId: "turn-1",
          sequence: 3,
          timestampMs: 500,
          event: { type: "text" },
        },
      })

      const state = getConversationRuntimeState(convId)
      expect(state?.lastSequence).toBe(5)
      expect(state?.events).toHaveLength(1)
    })

    it("should ignore events for different conversationId", () => {
      const convId = getTestConversationId()
      const listener = vi.fn()
      subscribeConversationRuntime(convId, listener)

      const subscribeCall = mocks.subscribe.mock.calls[0]
      const options = subscribeCall[1]

      options.onData({
        kind: "event",
        event: {
          conversationId: "different-conv", // Different conversation
          turnId: "turn-1",
          sequence: 1,
          timestampMs: 1000,
          event: { type: "thinking" },
        },
      })

      const state = getConversationRuntimeState(convId)
      expect(state?.events).toHaveLength(0)
    })

    it("should handle error events", () => {
      const convId = getTestConversationId()
      const listener = vi.fn()
      subscribeConversationRuntime(convId, listener)

      const subscribeCall = mocks.subscribe.mock.calls[0]
      const options = subscribeCall[1]

      options.onData({
        kind: "event",
        event: {
          conversationId: convId,
          turnId: "turn-1",
          sequence: 1,
          timestampMs: 1000,
          event: { type: "error", message: "Test error" },
        },
      })

      const state = getConversationRuntimeState(convId)
      expect(state?.status).toBe("error")
    })

    it("should handle done events", () => {
      const convId = getTestConversationId()
      const listener = vi.fn()
      subscribeConversationRuntime(convId, listener)

      const subscribeCall = mocks.subscribe.mock.calls[0]
      const options = subscribeCall[1]

      options.onData({
        kind: "event",
        event: {
          conversationId: convId,
          turnId: "turn-1",
          sequence: 1,
          timestampMs: 1000,
          event: { type: "done" },
        },
      })

      const state = getConversationRuntimeState(convId)
      expect(state?.status).toBe("completed")
    })
  })

  describe("Error handling", () => {
    it("should handle subscription errors", () => {
      const convId = getTestConversationId()
      const listener = vi.fn()
      subscribeConversationRuntime(convId, listener)

      const subscribeCall = mocks.subscribe.mock.calls[0]
      const options = subscribeCall[1]

      options.onError(new Error("Connection failed"))

      const state = getConversationRuntimeState(convId)
      expect(state?.connectionStatus).toBe("reconnecting")
      expect(state?.error).toBe("Connection failed")
    })

    it("should handle subscription completion", () => {
      const convId = getTestConversationId()
      const listener = vi.fn()
      subscribeConversationRuntime(convId, listener)

      const subscribeCall = mocks.subscribe.mock.calls[0]
      const options = subscribeCall[1]

      options.onComplete()

      // Should attempt to reconnect (handled internally)
      expect(listener).toHaveBeenCalled()
    })
  })

  describe("getConversationRuntimeState", () => {
    it("should return undefined for non-existent conversation", () => {
      const state = getConversationRuntimeState("non-existent")
      expect(state).toBeUndefined()
    })

    it("should return state for subscribed conversation", () => {
      const convId = getTestConversationId()
      subscribeConversationRuntime(convId, vi.fn())
      const state = getConversationRuntimeState(convId)
      expect(state).toBeDefined()
      expect(state?.conversationId).toBe(convId)
    })
  })
})
