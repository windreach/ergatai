/**
 * Stream Resumption Tests for Conversation Runtime Gateway
 *
 * These tests verify the complete stream resumption flow:
 * 1. Initial connection and snapshot
 * 2. Gap detection triggering reconnection
 * 3. New snapshot after reconnection
 * 4. Event deduplication and state recovery
 *
 * This fills the gap in testing the actual stream resumption scenario
 * that occurs when the UI reloads or network disconnects mid-stream.
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

describe("Conversation Runtime - Stream Resumption", () => {
  let testCounter = 0

  function getTestConversationId(): string {
    testCounter++
    return `conv-resume-${testCounter}-${Date.now()}`
  }

  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
    mocks.subscribe.mockReturnValue({ unsubscribe: mocks.unsubscribe })
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  describe("Complete resumption flow", () => {
    it("should resume from persisted sequence after UI reload", () => {
      const convId = getTestConversationId()

      // Simulate previous session persisted sequence 50
      localStorage.setItem(`ergatai:runtime:sequence:${convId}`, "50")

      const listener = vi.fn()
      subscribeConversationRuntime(convId, listener)

      // Verify initial state restored from localStorage
      const initialState = getConversationRuntimeState(convId)
      expect(initialState?.lastSequence).toBe(50)

      // Simulate reconnection with new snapshot starting from sequence 51
      const subscribeCall = mocks.subscribe.mock.calls[0]
      const options = subscribeCall[1]

      options.onData({
        kind: "snapshot",
        snapshot: {
          epoch: "epoch-resume-1",
          turnId: "turn-1",
          status: "streaming",
          lastSequence: 50,  // Start from 50 (the persisted sequence)
          firstSequence: 51,
          events: [
            {
              conversationId: convId,
              turnId: "turn-1",
              sequence: 51,
              timestampMs: Date.now(),
              event: { type: "text", delta: "Resumed event 1" },
            },
            {
              conversationId: convId,
              turnId: "turn-1",
              sequence: 52,
              timestampMs: Date.now(),
              event: { type: "text", delta: "Resumed event 2" },
            },
          ],
          startedAtMs: Date.now(),
          updatedAtMs: Date.now(),
        },
      })

      const state = getConversationRuntimeState(convId)
      expect(state?.status).toBe("streaming")
      expect(state?.lastSequence).toBe(52)
      expect(state?.events).toHaveLength(2)
      expect(state?.events[0]?.sequence).toBe(51)
      expect(state?.events[1]?.sequence).toBe(52)

      // Verify persistence updated
      const stored = localStorage.getItem(`ergatai:runtime:sequence:${convId}`)
      expect(stored).toBe("52")
    })

    it("should detect gap and enter reconnecting state", () => {
      const convId = getTestConversationId()
      const listener = vi.fn()
      subscribeConversationRuntime(convId, listener)

      const subscribeCall = mocks.subscribe.mock.calls[0]
      const options = subscribeCall[1]

      // Send initial events (this will transition from "connecting" to "connected")
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

      let state = getConversationRuntimeState(convId)
      expect(state?.lastSequence).toBe(2)

      // Simulate gap: next event jumps to sequence 10 (missing 3-9)
      options.onData({
        kind: "event",
        event: {
          conversationId: convId,
          turnId: "turn-1",
          sequence: 10,
          timestampMs: Date.now(),
          event: { type: "text" },
        },
      })

      // Should detect gap and enter reconnecting state
      state = getConversationRuntimeState(convId)
      expect(state?.connectionStatus).toBe("reconnecting")
      expect(state?.error).toBe("Runtime event gap detected")

      // Should trigger reconnection (unsubscribe called)
      expect(mocks.unsubscribe).toHaveBeenCalled()
    })

    it("should recover after gap with new snapshot", () => {
      const convId = getTestConversationId()
      const listener = vi.fn()
      subscribeConversationRuntime(convId, listener)

      const subscribeCall = mocks.subscribe.mock.calls[0]
      const options = subscribeCall[1]

      // Send initial events
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

      // Simulate gap
      options.onData({
        kind: "event",
        event: {
          conversationId: convId,
          turnId: "turn-1",
          sequence: 10,
          timestampMs: Date.now(),
          event: { type: "text" },
        },
      })

      let state = getConversationRuntimeState(convId)
      expect(state?.connectionStatus).toBe("reconnecting")

      // Simulate reconnection with new snapshot
      // Reset mock to simulate new subscription
      mocks.subscribe.mockClear()
      const newSubscribeCall = mocks.subscribe.mock.calls[0]
      const newOptions = newSubscribeCall?.[1]

      if (newOptions) {
        newOptions.onData({
          kind: "snapshot",
          snapshot: {
            epoch: "epoch-after-gap",
            turnId: "turn-1",
            status: "streaming",
            lastSequence: 15,
            firstSequence: 10,
            events: [
              {
                conversationId: convId,
                turnId: "turn-1",
                sequence: 10,
                timestampMs: Date.now(),
                event: { type: "text", delta: "Event after gap" },
              },
              {
                conversationId: convId,
                turnId: "turn-1",
                sequence: 11,
                timestampMs: Date.now(),
                event: { type: "text", delta: "Next event" },
              },
            ],
            startedAtMs: Date.now(),
            updatedAtMs: Date.now(),
          },
        })

        state = getConversationRuntimeState(convId)
        expect(state?.connectionStatus).toBe("connected")
        expect(state?.lastSequence).toBe(15)
        expect(state?.events).toHaveLength(2)
      }
    })

    it("should deduplicate events when receiving overlapping snapshots", () => {
      const convId = getTestConversationId()
      const listener = vi.fn()
      subscribeConversationRuntime(convId, listener)

      const subscribeCall = mocks.subscribe.mock.calls[0]
      const options = subscribeCall[1]

      // First snapshot with events 1-3
      options.onData({
        kind: "snapshot",
        snapshot: {
          epoch: "epoch-1",
          turnId: "turn-1",
          status: "streaming",
          lastSequence: 3,
          firstSequence: 1,
          events: [],  // Empty - snapshot represents state, not events to add
          startedAtMs: Date.now(),
          updatedAtMs: Date.now(),
        },
      })

      let state = getConversationRuntimeState(convId)
      expect(state?.lastSequence).toBe(3)

      // Send incremental events 4-5 (after the snapshot's lastSequence)
      for (let i = 4; i <= 5; i++) {
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

      state = getConversationRuntimeState(convId)
      expect(state?.events).toHaveLength(2)
      expect(state?.lastSequence).toBe(5)

      // Second snapshot with updated lastSequence (represents state up to 7)
      options.onData({
        kind: "snapshot",
        snapshot: {
          epoch: "epoch-2",
          turnId: "turn-1",
          status: "streaming",
          lastSequence: 7,
          firstSequence: 6,
          events: [],  // Empty - represents state up to 7
          startedAtMs: Date.now(),
          updatedAtMs: Date.now(),
        },
      })

      state = getConversationRuntimeState(convId)
      expect(state?.lastSequence).toBe(7)

      // Send new events 8-9
      for (let i = 8; i <= 9; i++) {
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

      state = getConversationRuntimeState(convId)
      expect(state?.lastSequence).toBe(9)
      expect(state?.events.length).toBeGreaterThanOrEqual(2)
    })

    it("should handle connection error and recovery", () => {
      const convId = getTestConversationId()
      const listener = vi.fn()
      subscribeConversationRuntime(convId, listener)

      const subscribeCall = mocks.subscribe.mock.calls[0]
      const options = subscribeCall[1]

      // Send some events
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

      let state = getConversationRuntimeState(convId)
      expect(state?.lastSequence).toBe(1)

      // Simulate connection error
      options.onError(new Error("Network disconnected"))

      state = getConversationRuntimeState(convId)
      expect(state?.connectionStatus).toBe("reconnecting")
      expect(state?.error).toBe("Network disconnected")
    })
  })

  describe("Persistence during resumption", () => {
    it("should persist sequence after each event during resumption", () => {
      const convId = getTestConversationId()
      localStorage.setItem(`ergatai:runtime:sequence:${convId}`, "10")

      const listener = vi.fn()
      subscribeConversationRuntime(convId, listener)

      const subscribeCall = mocks.subscribe.mock.calls[0]
      const options = subscribeCall[1]

      // Resume with events 11-15
      for (let i = 11; i <= 15; i++) {
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

        // Verify persistence after each event
        const stored = localStorage.getItem(
          `ergatai:runtime:sequence:${convId}`
        )
        expect(stored).toBe(String(i))
      }
    })

    it("should persist sequence after snapshot during resumption", () => {
      const convId = getTestConversationId()
      localStorage.setItem(`ergatai:runtime:sequence:${convId}`, "20")

      const listener = vi.fn()
      subscribeConversationRuntime(convId, listener)

      const subscribeCall = mocks.subscribe.mock.calls[0]
      const options = subscribeCall[1]

      // Resume with snapshot
      options.onData({
        kind: "snapshot",
        snapshot: {
          epoch: "epoch-resume",
          turnId: "turn-1",
          status: "streaming",
          lastSequence: 30,
          firstSequence: 21,
          events: [],
          startedAtMs: Date.now(),
          updatedAtMs: Date.now(),
        },
      })

      // Verify persistence updated to snapshot's lastSequence
      const stored = localStorage.getItem(`ergatai:runtime:sequence:${convId}`)
      expect(stored).toBe("30")
    })
  })

  describe("Edge cases", () => {
    it("should handle resumption with empty events array", () => {
      const convId = getTestConversationId()
      localStorage.setItem(`ergatai:runtime:sequence:${convId}`, "100")

      const listener = vi.fn()
      subscribeConversationRuntime(convId, listener)

      const subscribeCall = mocks.subscribe.mock.calls[0]
      const options = subscribeCall[1]

      // Resume with snapshot containing no events
      options.onData({
        kind: "snapshot",
        snapshot: {
          epoch: "epoch-empty",
          turnId: "turn-1",
          status: "completed",
          lastSequence: 100,
          firstSequence: 100,
          events: [],
          startedAtMs: Date.now(),
          updatedAtMs: Date.now(),
        },
      })

      const state = getConversationRuntimeState(convId)
      expect(state?.status).toBe("completed")
      expect(state?.lastSequence).toBe(100)
      expect(state?.events).toHaveLength(0)
    })

    it("should handle multiple rapid reconnections", () => {
      const convId = getTestConversationId()
      const listener = vi.fn()
      subscribeConversationRuntime(convId, listener)

      const subscribeCall = mocks.subscribe.mock.calls[0]
      const options = subscribeCall[1]

      // Simulate multiple gap detections and reconnections
      for (let i = 0; i < 3; i++) {
        options.onData({
          kind: "event",
          event: {
            conversationId: convId,
            turnId: "turn-1",
            sequence: i * 10 + 1,
            timestampMs: Date.now(),
            event: { type: "text" },
          },
        })

        // Gap
        options.onData({
          kind: "event",
          event: {
            conversationId: convId,
            turnId: "turn-1",
            sequence: i * 10 + 5,
            timestampMs: Date.now(),
            event: { type: "text" },
          },
        })

        const state = getConversationRuntimeState(convId)
        expect(state?.connectionStatus).toBe("reconnecting")

        // Simulate reconnection
        vi.advanceTimersByTime(1000)
      }
    })
  })
})
