/**
 * Concurrency and Stress Tests for Conversation Runtime
 *
 * These tests verify that the runtime handles concurrent operations,
 * high event volumes, and edge cases correctly.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest"

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

describe("Conversation Runtime - Concurrency and Stress", () => {
  let testCounter = 0

  function getTestConversationId(): string {
    testCounter++
    return `conv-stress-${testCounter}-${Date.now()}`
  }

  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
    mocks.subscribe.mockReturnValue({ unsubscribe: mocks.unsubscribe })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe("Concurrent subscriptions", () => {
    it("should handle multiple simultaneous subscriptions to same conversation", () => {
      const convId = getTestConversationId()
      const listeners = Array.from({ length: 10 }, () => vi.fn())

      // Subscribe 10 listeners simultaneously
      const unsubscribes = listeners.map((listener) =>
        subscribeConversationRuntime(convId, listener)
      )

      // Should only create one underlying subscription
      expect(mocks.subscribe).toHaveBeenCalledTimes(1)

      // All listeners should have been called with initial state
      listeners.forEach((listener) => {
        expect(listener).toHaveBeenCalled()
      })

      // Send an event
      const subscribeCall = mocks.subscribe.mock.calls[0]
      const options = subscribeCall[1]
      options.onData({
        kind: "event",
        event: {
          conversationId: convId,
          turnId: "turn-1",
          sequence: 1,
          timestampMs: 1000,
          event: { type: "thinking" },
        },
      })

      // All listeners should receive the event (called at least twice)
      listeners.forEach((listener) => {
        expect(listener.mock.calls.length).toBeGreaterThanOrEqual(2)
      })

      // Unsubscribe all
      unsubscribes.forEach((unsubscribe) => unsubscribe())
    })

    it("should handle rapid subscribe/unsubscribe cycles", () => {
      const convId = getTestConversationId()

      // Rapidly subscribe and unsubscribe 20 times
      for (let i = 0; i < 20; i++) {
        const listener = vi.fn()
        const unsubscribe = subscribeConversationRuntime(convId, listener)
        unsubscribe()
      }

      // Should not crash or leak memory
      const state = getConversationRuntimeState(convId)
      expect(state).toBeDefined()
    })

    it("should handle subscriptions to many different conversations", () => {
      const conversationIds = Array.from({ length: 50 }, () =>
        getTestConversationId()
      )

      // Subscribe to 50 different conversations
      conversationIds.forEach((convId) => {
        subscribeConversationRuntime(convId, vi.fn())
      })

      // Should create 50 separate subscriptions
      expect(mocks.subscribe).toHaveBeenCalledTimes(50)

      // Each should have its own state
      conversationIds.forEach((convId) => {
        const state = getConversationRuntimeState(convId)
        expect(state).toBeDefined()
        expect(state?.conversationId).toBe(convId)
      })
    })
  })

  describe("High event volume", () => {
    it("should handle 1000 events without performance degradation", () => {
      const convId = getTestConversationId()
      const listener = vi.fn()
      subscribeConversationRuntime(convId, listener)

      const subscribeCall = mocks.subscribe.mock.calls[0]
      const options = subscribeCall[1]

      const startTime = performance.now()

      // Send 1000 events
      for (let i = 1; i <= 1000; i++) {
        options.onData({
          kind: "event",
          event: {
            conversationId: convId,
            turnId: "turn-1",
            sequence: i,
            timestampMs: Date.now(),
            event: { type: "text", delta: `Event ${i}` },
          },
        })
      }

      const endTime = performance.now()
      const duration = endTime - startTime

      // Should complete in reasonable time (< 1 second for 1000 events)
      expect(duration).toBeLessThan(1000)

      const state = getConversationRuntimeState(convId)
      expect(state?.lastSequence).toBe(1000)
    })

    it("should detect gaps when events arrive out of order", () => {
      const convId = getTestConversationId()
      const listener = vi.fn()
      subscribeConversationRuntime(convId, listener)

      const subscribeCall = mocks.subscribe.mock.calls[0]
      const options = subscribeCall[1]

      // Send events out of order: 5, then 7 (gap detected: 7 > 5+1)
      options.onData({
        kind: "event",
        event: {
          conversationId: convId,
          turnId: "turn-1",
          sequence: 5,
          timestampMs: Date.now(),
          event: { type: "text" },
        },
      })

      // This should trigger gap detection (7 > 5+1=6)
      options.onData({
        kind: "event",
        event: {
          conversationId: convId,
          turnId: "turn-1",
          sequence: 7,
          timestampMs: Date.now(),
          event: { type: "text" },
        },
      })

      const state = getConversationRuntimeState(convId)
      // Should detect gap and enter reconnecting state
      expect(state?.connectionStatus).toBe("reconnecting")
      expect(state?.error).toBe("Runtime event gap detected")
    })

    it("should handle rapid snapshot updates", () => {
      const convId = getTestConversationId()
      const listener = vi.fn()
      subscribeConversationRuntime(convId, listener)

      const subscribeCall = mocks.subscribe.mock.calls[0]
      const options = subscribeCall[1]

      // Send 100 rapid snapshot updates
      for (let i = 0; i < 100; i++) {
        options.onData({
          kind: "snapshot",
          snapshot: {
            epoch: `epoch-${i}`,
            turnId: `turn-${i}`,
            status: "streaming",
            lastSequence: i * 10,
            firstSequence: 1,
            events: [],
            startedAtMs: Date.now(),
            updatedAtMs: Date.now(),
          },
        })
      }

      const state = getConversationRuntimeState(convId)
      expect(state?.lastSequence).toBe(990)
    })
  })

  describe("Persistence under stress", () => {
    it("should persist sequence correctly after 100 events", () => {
      const convId = getTestConversationId()
      const listener = vi.fn()
      subscribeConversationRuntime(convId, listener)

      const subscribeCall = mocks.subscribe.mock.calls[0]
      const options = subscribeCall[1]

      // Send 100 events
      for (let i = 1; i <= 100; i++) {
        options.onData({
          kind: "event",
          event: {
            conversationId: convId,
            turnId: "turn-1",
            sequence: i,
            timestampMs: Date.now(),
            event: { type: "text" },
          },
        })
      }

      // Check localStorage
      const stored = localStorage.getItem(
        `ergatai:runtime:sequence:${convId}`
      )
      expect(stored).toBe("100")
    })

    it("should handle localStorage quota exceeded gracefully", () => {
      const convId = getTestConversationId()

      // Mock localStorage.setItem to throw quota exceeded error
      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
      vi.spyOn(localStorage, "setItem").mockImplementation(() => {
        throw new Error("QuotaExceededError")
      })

      const listener = vi.fn()
      subscribeConversationRuntime(convId, listener)

      const subscribeCall = mocks.subscribe.mock.calls[0]
      const options = subscribeCall[1]

      // Should not throw when trying to persist
      expect(() => {
        options.onData({
          kind: "event",
          event: {
            conversationId: convId,
            turnId: "turn-1",
            sequence: 1,
            timestampMs: Date.now(),
            event: { type: "text" },
          },
        })
      }).not.toThrow()

      // Should still process the event
      const state = getConversationRuntimeState(convId)
      expect(state?.lastSequence).toBe(1)
    })
  })

  describe("Race conditions", () => {
    it("should handle subscribe and immediate event", () => {
      const convId = getTestConversationId()
      const listener = vi.fn()

      // Subscribe
      const unsubscribe = subscribeConversationRuntime(convId, listener)

      // Immediately send an event (before subscription might be fully set up)
      const subscribeCall = mocks.subscribe.mock.calls[0]
      const options = subscribeCall[1]
      options.onData({
        kind: "event",
        event: {
          conversationId: convId,
          turnId: "turn-1",
          sequence: 1,
          timestampMs: Date.now(),
          event: { type: "thinking" },
        },
      })

      // Should handle gracefully
      const state = getConversationRuntimeState(convId)
      expect(state?.lastSequence).toBe(1)

      unsubscribe()
    })

    it("should handle unsubscribe during event processing", () => {
      const convId = getTestConversationId()
      const listener = vi.fn()
      const unsubscribe = subscribeConversationRuntime(convId, listener)

      const subscribeCall = mocks.subscribe.mock.calls[0]
      const options = subscribeCall[1]

      // Start sending events
      for (let i = 1; i <= 5; i++) {
        options.onData({
          kind: "event",
          event: {
            conversationId: convId,
            turnId: "turn-1",
            sequence: i,
            timestampMs: Date.now(),
            event: { type: "text" },
          },
        })

        // Unsubscribe in the middle
        if (i === 3) {
          unsubscribe()
        }
      }

      // Should not crash
      expect(listener).toHaveBeenCalled()
    })

    it("should handle multiple listeners subscribing/unsubscribing concurrently", () => {
      const convId = getTestConversationId()
      const listeners = Array.from({ length: 5 }, () => vi.fn())
      const unsubscribes: (() => void)[] = []

      // Subscribe all
      listeners.forEach((listener) => {
        unsubscribes.push(subscribeConversationRuntime(convId, listener))
      })

      const subscribeCall = mocks.subscribe.mock.calls[0]
      const options = subscribeCall[1]

      // Send first event
      options.onData({
        kind: "event",
        event: {
          conversationId: convId,
          turnId: "turn-1",
          sequence: 1,
          timestampMs: Date.now(),
          event: { type: "text" },
        },
      })

      // Unsubscribe first 3 listeners
      unsubscribes.slice(0, 3).forEach((unsubscribe) => unsubscribe())

      // Reset mock call counts to track only new calls
      listeners.forEach((listener) => listener.mockClear())

      // Send second event
      options.onData({
        kind: "event",
        event: {
          conversationId: convId,
          turnId: "turn-1",
          sequence: 2,
          timestampMs: Date.now(),
          event: { type: "text" },
        },
      })

      // First 3 listeners (unsubscribed) should NOT receive the second event
      listeners.slice(0, 3).forEach((listener) => {
        expect(listener).not.toHaveBeenCalled()
      })

      // Last 2 listeners (still subscribed) should receive the second event
      listeners.slice(3).forEach((listener) => {
        expect(listener).toHaveBeenCalled()
      })
    })
  })
})
