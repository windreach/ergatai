import { describe, it, expect } from "vitest"
import {
  extractAgentMentions,
  parseImplicitRuntimeEvent,
  applyImplicitRuntimeEvent,
} from "@/features/agents/collaboration/implicit-collaboration"

describe("extractAgentMentions", () => {
  it("extracts unique mentions", () => {
    expect(extractAgentMentions("@[agent:a] and @[agent:b] and @[agent:a]")).toEqual(["a", "b"])
  })
  it("empty when none", () => {
    expect(extractAgentMentions("no mentions")).toEqual([])
  })
})

describe("parseImplicitRuntimeEvent", () => {
  it("null for non-record", () => {
    expect(parseImplicitRuntimeEvent(null)).toBeNull()
    expect(parseImplicitRuntimeEvent("x")).toBeNull()
  })
  it("null when sessionId/chatId missing", () => {
    expect(parseImplicitRuntimeEvent({ type: "session_created" })).toBeNull()
  })
  it("parses session_created", () => {
    const e = parseImplicitRuntimeEvent({
      type: "session_created",
      sessionId: "s1",
      chatId: "c1",
      mode: "group",
    })
    expect(e).toMatchObject({ type: "session_created", mode: "group", route: "supervisor_session" })
  })
  it("invalid mode returns null", () => {
    expect(parseImplicitRuntimeEvent({
      type: "session_created",
      sessionId: "s1",
      chatId: "c1",
      mode: "x",
    })).toBeNull()
  })
  it("parses run_created with default title", () => {
    const e = parseImplicitRuntimeEvent({
      type: "run_created",
      sessionId: "s1",
      chatId: "c1",
      runId: "r1",
    })
    expect(e).toMatchObject({ type: "run_created", title: "Collaboration task" })
  })
  it("parses session_completed", () => {
    const e = parseImplicitRuntimeEvent({ type: "session_completed", sessionId: "s1", chatId: "c1" })
    expect(e).toMatchObject({ type: "session_completed" })
  })
  it("parses session_failed with default reason", () => {
    const e = parseImplicitRuntimeEvent({ type: "session_failed", sessionId: "s1", chatId: "c1" })
    expect(e).toMatchObject({ type: "session_failed", reason: "Collaboration session failed" })
  })
  it("unknown type returns null", () => {
    expect(parseImplicitRuntimeEvent({ type: "foo", sessionId: "s1", chatId: "c1" })).toBeNull()
  })
})

describe("applyImplicitRuntimeEvent", () => {
  it("creates task on session_created", () => {
    const out = applyImplicitRuntimeEvent([], {
      type: "session_created",
      sessionId: "s1",
      chatId: "c1",
      mode: "supervisor",
      route: "r",
    })
    expect(out).toHaveLength(1)
    expect(out[0].status).toBe("pending")
  })
  it("ignores non-session_created for unknown session", () => {
    const out = applyImplicitRuntimeEvent([], {
      type: "run_created",
      sessionId: "s1",
      runId: "r1",
      chatId: "c1",
      title: "t",
    })
    expect(out).toHaveLength(0)
  })
  it("updates existing task on run_created", () => {
    const tasks = applyImplicitRuntimeEvent([], {
      type: "session_created",
      sessionId: "s1",
      chatId: "c1",
      mode: "supervisor",
      route: "r",
    })
    const out = applyImplicitRuntimeEvent(tasks, {
      type: "run_created",
      sessionId: "s1",
      runId: "r1",
      chatId: "c1",
      title: "my task",
    })
    expect(out[0].runId).toBe("r1")
    expect(out[0].title).toBe("my task")
    expect(out[0].status).toBe("running")
  })
  it("completes and fails", () => {
    const tasks = applyImplicitRuntimeEvent([], {
      type: "session_created",
      sessionId: "s1",
      chatId: "c1",
      mode: "supervisor",
      route: "r",
    })
    const done = applyImplicitRuntimeEvent(tasks, { type: "session_completed", sessionId: "s1", chatId: "c1" })
    expect(done[0].status).toBe("completed")
    const failed = applyImplicitRuntimeEvent(tasks, { type: "session_failed", sessionId: "s1", chatId: "c1", reason: "boom" })
    expect(failed[0].status).toBe("failed")
    expect(failed[0].summary).toBe("boom")
  })
})
