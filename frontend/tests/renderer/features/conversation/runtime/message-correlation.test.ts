import { describe, it, expect } from "vitest"
import {
  createMessageCorrelation,
  createLocalTransportMessageMetadata,
  createOptimisticMessage,
  LOCAL_TRANSPORT_STREAM_SOURCE,
} from "@/features/conversation/runtime/message-correlation"

describe("createLocalTransportMessageMetadata", () => {
  it("includes streamSource", () => {
    const m = createLocalTransportMessageMetadata()
    expect(m.streamSource).toBe(LOCAL_TRANSPORT_STREAM_SOURCE)
  })
  it("includes externalMessageId when provided", () => {
    const m = createLocalTransportMessageMetadata({ externalMessageId: "e1" })
    expect(m.externalMessageId).toBe("e1")
  })
  it("omits externalMessageId when not provided", () => {
    const m = createLocalTransportMessageMetadata()
    expect(m.externalMessageId).toBeUndefined()
  })
  it("merges metadata", () => {
    const m = createLocalTransportMessageMetadata({ metadata: { foo: 1 } })
    expect((m as any).foo).toBe(1)
  })
})

describe("createMessageCorrelation", () => {
  it("sets externalMessageId", () => {
    const c = createMessageCorrelation("e1")
    expect(c.externalMessageId).toBe("e1")
    expect(c.transportOverrides.externalMessageId).toBe("e1")
    expect(c.metadata.externalMessageId).toBe("e1")
  })
  it("undefined", () => {
    const c = createMessageCorrelation()
    expect(c.externalMessageId).toBeUndefined()
    expect(c.metadata.externalMessageId).toBeUndefined()
  })
})

describe("createOptimisticMessage", () => {
  it("creates message", () => {
    const msg = createOptimisticMessage({ role: "user", parts: [{ type: "text", text: "hi" } as any], externalMessageId: "e1" })
    expect(msg.id).toBe("e1")
    expect(msg.role).toBe("user")
    expect(msg.parts).toHaveLength(1)
    expect(msg.metadata.externalMessageId).toBe("e1")
  })
  it("without externalMessageId", () => {
    const msg = createOptimisticMessage({ role: "assistant", parts: [] })
    expect(msg.id).toBeUndefined()
    expect(msg.metadata.streamSource).toBe(LOCAL_TRANSPORT_STREAM_SOURCE)
  })
})
