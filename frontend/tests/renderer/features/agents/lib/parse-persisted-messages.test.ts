import { describe, expect, it } from "vitest"
import { parsePersistedMessagesByConversation } from "../../../../../src/renderer/features/agents/lib/parse-persisted-messages"

describe("parsePersistedMessagesByConversation", () => {
  it("keeps array messages as-is", () => {
    const result = parsePersistedMessagesByConversation([
      { id: "c1", messages: [{ id: "m1" }] },
    ])
    expect(result.get("c1")).toEqual([{ id: "m1" }])
  })

  it("parses JSON string messages", () => {
    const result = parsePersistedMessagesByConversation([
      { id: "c1", messages: JSON.stringify([{ id: "m1" }]) },
    ])
    expect(result.get("c1")).toEqual([{ id: "m1" }])
  })

  it("falls back to empty array on invalid JSON", () => {
    const result = parsePersistedMessagesByConversation([
      { id: "c1", messages: "{not json" },
    ])
    expect(result.get("c1")).toEqual([])
  })

  it("handles missing messages", () => {
    const result = parsePersistedMessagesByConversation([{ id: "c1" }])
    expect(result.get("c1")).toEqual([])
  })
})