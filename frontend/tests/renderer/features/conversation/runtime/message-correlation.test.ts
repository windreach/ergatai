import { describe, expect, it } from "vitest"

import {
  LOCAL_TRANSPORT_STREAM_SOURCE,
  createMessageCorrelation,
  createOptimisticMessage,
} from "@/features/conversation/runtime/message-correlation"

describe("message correlation primitives", () => {
  it("creates the same correlation identity for transport and optimistic metadata", () => {
    const correlation = createMessageCorrelation("msg_1000_000_0001")

    expect(correlation.transportOverrides).toEqual({
      externalMessageId: "msg_1000_000_0001",
    })
    expect(correlation.metadata).toEqual({
      externalMessageId: "msg_1000_000_0001",
      streamSource: LOCAL_TRANSPORT_STREAM_SOURCE,
    })
  })

  it("builds an optimistic local-transport message", () => {
    const message = createOptimisticMessage({
      role: "agent",
      parts: [{ type: "text", text: "hello" }],
      externalMessageId: "msg_1000_000_0002",
      metadata: { correlationId: "corr-1" },
    })

    expect(message.id).toBe("msg_1000_000_0002")
    expect(message.metadata).toEqual({
      correlationId: "corr-1",
      externalMessageId: "msg_1000_000_0002",
      streamSource: LOCAL_TRANSPORT_STREAM_SOURCE,
    })
  })
})
