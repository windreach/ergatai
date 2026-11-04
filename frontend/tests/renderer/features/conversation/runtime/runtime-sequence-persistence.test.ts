import { describe, it, expect, beforeEach } from "vitest"
import {
  readPersistedSequence,
  persistSequence,
  removePersistedSequence,
} from "../../../../../src/renderer/features/conversation/runtime/runtime-sequence-persistence"

describe("runtime-sequence-persistence", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it("returns null when nothing persisted", () => {
    expect(readPersistedSequence("conv-1")).toBeNull()
  })

  it("persists and reads a valid sequence", () => {
    persistSequence("conv-1", 42)
    expect(readPersistedSequence("conv-1")).toBe(42)
  })

  it("ignores invalid sequence values", () => {
    persistSequence("conv-1", -1)
    expect(readPersistedSequence("conv-1")).toBeNull()
    persistSequence("conv-1", 1.5)
    expect(readPersistedSequence("conv-1")).toBeNull()
  })

  it("removes persisted sequence", () => {
    persistSequence("conv-1", 7)
    removePersistedSequence("conv-1")
    expect(readPersistedSequence("conv-1")).toBeNull()
  })

  it("isolates sequences by conversation", () => {
    persistSequence("conv-a", 1)
    persistSequence("conv-b", 2)
    expect(readPersistedSequence("conv-a")).toBe(1)
    expect(readPersistedSequence("conv-b")).toBe(2)
  })
})
