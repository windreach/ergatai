import { describe, expect, it, beforeEach } from "vitest"

import {
  messageAtomFamily,
  getPerChatMessageKey,
  syncMessagesWithStatusAtom,
  type Message,
} from "../../../../../src/renderer/features/agents/stores/message-store"
import { appStore } from "../../../../../src/renderer/lib/jotai-store"

const CONVERSATION_ID = "conv-sync-test"

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "m1",
    role: "assistant",
    parts: [
      { type: "text", text: "第一段" },
      { type: "tool-test", state: "input-available", input: { q: 1 } },
    ],
    metadata: { tokens: 10 },
    ...overrides,
  }
}

function sync(messages: Message[], status = "streaming") {
  appStore.set(syncMessagesWithStatusAtom, {
    messages,
    status,
    conversationId: CONVERSATION_ID,
    updateGlobal: false,
  })
}

function atomMessage(id: string): Message | null {
  return appStore.get(messageAtomFamily(getPerChatMessageKey(CONVERSATION_ID, id)))
}

describe("message store sync (P1 immutability)", () => {
  beforeEach(() => {
    appStore.set(syncMessagesWithStatusAtom, {
      messages: [],
      status: "ready",
      conversationId: CONVERSATION_ID,
      updateGlobal: false,
    })
  })

  it("stores a deep-frozen snapshot, so later source mutations never leak into the atom", () => {
    const source = makeMessage()
    sync([source])

    const stored = atomMessage("m1")
    expect(stored).toBeTruthy()
    expect(Object.isFrozen(stored)).toBe(true)
    expect(Object.isFrozen(stored!.parts)).toBe(true)
    expect(Object.isFrozen(stored!.parts![0])).toBe(true)

    // The AI SDK mutates its source objects in place — the atom must not care.
    source.parts![0] = { type: "text", text: "原地改掉的内容" }
    source.parts![1].input = { q: 999 }
    expect(atomMessage("m1")!.parts![0]).toEqual({ type: "text", text: "第一段" })
    expect(atomMessage("m1")!.parts![1].input).toEqual({ q: 1 })
  })

  it("detects in-place mutations of non-last parts via the complete fingerprint", () => {
    const source = makeMessage()
    sync([source])
    const before = atomMessage("m1")

    // Mutate the FIRST (non-last) part in place — the previous partial diff
    // (last part only) missed this class of change entirely.
    source.parts![0] = { type: "text", text: "第一段（已更新）" }
    sync([source])

    const after = atomMessage("m1")!
    expect(after).not.toBe(before)
    expect(after.parts![0]).toEqual({ type: "text", text: "第一段（已更新）" })
    // Other parts keep their content but are still fresh clones.
    expect(after.parts![1]).toEqual(source.parts![1])
  })

  it("keeps atom identity stable when content did not change (no re-render churn)", () => {
    const source = makeMessage()
    sync([source])
    const before = atomMessage("m1")

    sync([source])
    sync([source])

    expect(atomMessage("m1")).toBe(before)
  })

  it("removes atoms and fingerprint state when a message disappears", () => {
    const source = makeMessage()
    sync([source])
    expect(atomMessage("m1")).toBeTruthy()

    sync([])
    expect(atomMessage("m1")).toBeNull()

    // Re-adding works (fingerprint cache was cleaned, not stale).
    const updated = makeMessage({ parts: [{ type: "text", text: "重新出现" }] })
    sync([updated])
    expect(atomMessage("m1")!.parts![0]).toEqual({ type: "text", text: "重新出现" })
  })
})
