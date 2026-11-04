import { describe, it, expect } from "vitest"
import {
  shouldResnapshot,
  mergeSnapshot,
} from "../../../../../src/renderer/features/details-sidebar/lib/conversation-runtime-gateway"
import type { ConversationRuntimeState } from "../../../../../src/renderer/features/details-sidebar/lib/conversation-runtime-gateway"

describe("conversation-runtime-gateway merge logic", () => {
  it("shouldResnapshot when previous is missing", () => {
    expect(
      shouldResnapshot(undefined, { epoch: "e1", turnId: "t1", firstSequence: 1 }),
    ).toBe(true)
  })

  it("shouldResnapshot when epoch changes", () => {
    const previous: ConversationRuntimeState = {
      conversationId: "c1",
      status: "streaming",
      connectionStatus: "connected",
      epoch: "e1",
      lastSequence: 3,
      events: [],
    }
    expect(
      shouldResnapshot(previous, { epoch: "e2", turnId: "t1", firstSequence: 1 }),
    ).toBe(true)
  })

  it("mergeSnapshot returns connected state for contiguous events", () => {
    const previous: ConversationRuntimeState = {
      conversationId: "c1",
      status: "streaming",
      connectionStatus: "connected",
      epoch: "e1",
      turnId: "t1",
      lastSequence: 1,
      events: [],
    }
    const snapshot = {
      epoch: "e1",
      turnId: "t1",
      status: "streaming" as const,
      lastSequence: 3,
      firstSequence: 2,
      events: [
        {
          conversationId: "c1",
          turnId: "t1",
          sequence: 2,
          timestampMs: 100,
          event: { type: "text", delta: "hi" },
        },
      ],
    }
    const next = mergeSnapshot("c1", previous, snapshot)
    expect(next.connectionStatus).toBe("connected")
    expect(next.lastSequence).toBe(2)
    expect(next.events.length).toBe(1)
  })

  it("mergeSnapshot marks reconnecting on sequence gap", () => {
    const previous: ConversationRuntimeState = {
      conversationId: "c1",
      status: "streaming",
      connectionStatus: "connected",
      epoch: "e1",
      turnId: "t1",
      lastSequence: 1,
      events: [],
    }
    const snapshot = {
      epoch: "e1",
      turnId: "t1",
      status: "streaming" as const,
      lastSequence: 5,
      firstSequence: 2,
      events: [
        {
          conversationId: "c1",
          turnId: "t1",
          sequence: 2,
          timestampMs: 100,
          event: { type: "text", delta: "ok" },
        },
        {
          conversationId: "c1",
          turnId: "t1",
          sequence: 4,
          timestampMs: 101,
          event: { type: "text", delta: "gap" },
        },
      ],
    }
    const next = mergeSnapshot("c1", previous, snapshot)
    expect(next.connectionStatus).toBe("reconnecting")
  })
})