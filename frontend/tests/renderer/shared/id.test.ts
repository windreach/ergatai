import { describe, it, expect } from "vitest"
import { isPersistedMessageId, randomToken, createLocalId } from "../../../src/shared/id"

describe("isPersistedMessageId", () => {
  it("accepts valid backend id", () => {
    expect(isPersistedMessageId("msg_1234567890123_1_1")).toBe(true)
  })
  it("rejects non-string", () => {
    expect(isPersistedMessageId(123)).toBe(false)
    expect(isPersistedMessageId(null)).toBe(false)
    expect(isPersistedMessageId(undefined)).toBe(false)
  })
  it("rejects local-ish ids", () => {
    expect(isPersistedMessageId("local_123")).toBe(false)
  })
  it("rejects instance > 1023", () => {
    expect(isPersistedMessageId("msg_1234567890123_1024_1")).toBe(false)
  })
  it("rejects sequence > 4095", () => {
    expect(isPersistedMessageId("msg_1234567890123_1_4096")).toBe(false)
  })
  it("accepts boundary values", () => {
    expect(isPersistedMessageId("msg_1234567890123_1023_4095")).toBe(true)
  })
  it("rejects timestamp too long", () => {
    expect(isPersistedMessageId("msg_1234567890123456_1_1")).toBe(false)
  })
  it("rejects malformed separators", () => {
    expect(isPersistedMessageId("msg_1_2")).toBe(false)
    expect(isPersistedMessageId("msg_1_2_3_4")).toBe(false)
  })
})

describe("randomToken", () => {
  it("returns hex of requested length", () => {
    const t = randomToken(4)
    expect(t).toMatch(/^[0-9a-f]{8}$/)
  })
})

describe("createLocalId", () => {
  it("includes prefix when provided", () => {
    const id = createLocalId("pane")
    expect(id.startsWith("pane_")).toBe(true)
  })
  it("works without prefix", () => {
    const id = createLocalId()
    expect(typeof id).toBe("string")
    expect(id.length).toBeGreaterThan(0)
  })
  it("generates unique ids", () => {
    const set = new Set<string>()
    for (let i = 0; i < 100; i++) set.add(createLocalId())
    expect(set.size).toBe(100)
  })
})
