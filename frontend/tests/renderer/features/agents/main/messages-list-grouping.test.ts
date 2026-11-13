import { describe, expect, it } from "vitest"

import { buildMergedMsgGroups } from "@/features/agents/main/messages-list"
import type { Message, MessagePart } from "@/features/agents/stores/message-store"

function assistantMessage(
  id: string,
  parts: MessagePart[],
  metadata?: Record<string, unknown>,
): Message {
  return { id, role: "assistant", parts, metadata }
}

describe("buildMergedMsgGroups", () => {
  it("merges a tool-only turn with the following final-text message", () => {
    const step = assistantMessage("turn-1", [
      { type: "tool-Thinking", state: "result", input: { text: "thinking" } },
      { type: "tool-execute", state: "result", input: { code: "run()" } },
    ])
    const final = assistantMessage("turn-2", [
      { type: "tool-Thinking", state: "result", input: { text: "answer" } },
      { type: "text", text: "你好！有什么我可以帮你的吗？" },
    ])

    const groups = buildMergedMsgGroups(
      [step.id, final.id],
      [step, final],
    )

    expect(groups).toHaveLength(1)
    expect(groups[0]?.merged).toBe(true)
    expect(groups[0]?.ids).toEqual(["turn-1", "turn-2"])
    expect(groups[0]?.lastId).toBe("turn-2")
    expect(groups[0]?.parts.map((part) => part.type)).toEqual([
      "tool-Thinking",
      "tool-execute",
      "tool-Thinking",
      "text",
    ])
  })

  it("keeps consecutive text-bearing messages as separate render units", () => {
    const first = assistantMessage("m1", [{ type: "text", text: "第一段" }])
    const second = assistantMessage("m2", [{ type: "text", text: "第二段" }])

    const groups = buildMergedMsgGroups([first.id, second.id], [first, second])

    expect(groups).toHaveLength(2)
    expect(groups.map((group) => group.merged)).toEqual([false, false])
    expect(groups.map((group) => group.id)).toEqual(["m1", "m2"])
  })

  it("merges multiple step-only messages before the final text", () => {
    const step1 = assistantMessage("s1", [
      { type: "reasoning", text: "first" },
    ])
    const step2 = assistantMessage("s2", [
      { type: "tool-execute", state: "result", input: { code: "run()" } },
    ])
    const final = assistantMessage(
      "s3",
      [{ type: "text", text: "done" }],
      { outputTokens: 12 },
    )

    const groups = buildMergedMsgGroups(
      [step1.id, step2.id, final.id],
      [step1, step2, final],
    )

    expect(groups).toHaveLength(1)
    expect(groups[0]?.merged).toBe(true)
    expect(groups[0]?.ids).toEqual(["s1", "s2", "s3"])
    expect(groups[0]?.metadata).toMatchObject({ outputTokens: 12 })
    expect(groups[0]?.parts.map((part) => part.type)).toEqual([
      "reasoning",
      "tool-execute",
      "text",
    ])
  })

  it("uses the backend turn id as a stable React key across source handoff", () => {
    const runtime = assistantMessage(
      "runtime-turn-1-0",
      [{ type: "text", text: "hello" }],
      { turnId: "turn-1", runtime: true },
    )
    const persisted = assistantMessage(
      "msg-persisted-1",
      [{ type: "text", text: "hello" }],
      { turnId: "turn-1" },
    )

    const runtimeGroups = buildMergedMsgGroups([runtime.id], [runtime])
    const persistedGroups = buildMergedMsgGroups([persisted.id], [persisted])

    expect(runtimeGroups[0]?.id).toBe("runtime-turn-1-0")
    expect(persistedGroups[0]?.id).toBe("msg-persisted-1")
    // Same turn => same React key, so the component tree survives the swap.
    expect(runtimeGroups[0]?.key).toBe("turn-1")
    expect(persistedGroups[0]?.key).toBe("turn-1")
  })

  it("keeps group keys unique when multiple groups share a turn id", () => {
    const first = assistantMessage(
      "m1",
      [{ type: "text", text: "第一段" }],
      { turnId: "turn-1" },
    )
    const second = assistantMessage(
      "m2",
      [{ type: "text", text: "第二段" }],
      { turnId: "turn-1" },
    )

    const groups = buildMergedMsgGroups([first.id, second.id], [first, second])

    expect(groups.map((group) => group.key)).toEqual(["turn-1", "turn-1#1"])
  })

  it("flushes trailing step-only messages instead of dropping them", () => {
    const step = assistantMessage("s1", [
      { type: "tool-execute", state: "result", input: { code: "run()" } },
    ])

    const groups = buildMergedMsgGroups([step.id], [step])

    expect(groups).toHaveLength(1)
    expect(groups[0]?.merged).toBe(false)
    expect(groups[0]?.ids).toEqual(["s1"])
  })
})
