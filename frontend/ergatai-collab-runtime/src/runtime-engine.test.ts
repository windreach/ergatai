import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import assert from "node:assert/strict"
import { before, describe, test } from "node:test"

import { RuntimeEngine } from "./runtime-engine"
import { SessionStore } from "./session-store"

describe("RuntimeEngine", () => {
  let dataDir: string
  let store: SessionStore
  let engine: RuntimeEngine

  before(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "ergatai-runtime-"))
    store = new SessionStore(dataDir)
    engine = new RuntimeEngine(store)
  })

  test("runs supervisor, group, and single-agent strategies", async () => {
    const singleAgent = await engine.applyInteraction({
      type: "message_submitted",
      chatId: "single-chat",
      text: "Fix the login timeout",
      workspaceId: "workspace-1",
    })

    assert.equal(singleAgent.route, "single_agent_run")
    assert(singleAgent.sessionId)
    assert(singleAgent.runId)
    assert.ok(
      singleAgent.events.some((event) => event.type === "session_completed"),
    )
    assert.ok(
      singleAgent.events.some((event) => event.type === "progress_updated"),
    )

    const group = await engine.applyInteraction(
      {
        type: "message_submitted",
        chatId: "group-chat",
        text: "hello",
        mentions: ["codex"],
      },
      "group",
    )

    assert.equal(group.route, "group_session")
    assert.ok(group.events.some((event) => event.type === "session_completed"))
  })

  test("interrupts supervisor work and resumes after approval", async () => {
    const started = await engine.applyInteraction({
      type: "message_submitted",
      chatId: "supervisor-chat",
      text: "Investigate the timeout and then implement a fix",
      workspaceId: "workspace-1",
    })

    assert.equal(started.route, "supervisor_session")
    const approval = started.events.find(
      (event) => event.type === "approval_required",
    )
    assert(approval && approval.type === "approval_required")
    assert.equal(approval.sessionId, started.sessionId)
    assert.equal(approval.runId, started.runId)

    const approved = await engine.approve(approval.approvalId)
    assert.equal(approved.route, "supervisor_session")
    assert.equal(approved.sessionId, started.sessionId)
    assert.ok(approved.events.some((event) => event.type === "session_completed"))
  })

  test("persists and restores a supervisor approval checkpoint", async () => {
    const started = await engine.applyInteraction({
      type: "message_submitted",
      chatId: "recovery-chat",
      text: "Investigate the timeout and then implement a fix",
    })

    assert.equal(started.route, "supervisor_session")
    assert(started.sessionId)

    const restoredStore = new SessionStore(dataDir)
    const restored = new RuntimeEngine(restoredStore)
    await restored.recover()

    const approval = started.events.find(
      (event) => event.type === "approval_required",
    )
    assert(approval && approval.type === "approval_required")
    const approved = await restored.approve(approval.approvalId)
    assert.ok(approved.events.some((event) => event.type === "session_completed"))
  })
})
