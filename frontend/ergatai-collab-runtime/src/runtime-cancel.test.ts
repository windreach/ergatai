import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { RuntimeEngine } from "./runtime-engine"
import { SessionStore } from "./session-store"

describe("RuntimeEngine cancellation", () => {
  test("cancels a supervisor approval and clears its pending approval", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "ergatai-cancel-"))
    const engine = new RuntimeEngine(
      new SessionStore(dataDir),
    )
    const started = await engine.applyInteraction({
      type: "message_submitted",
      chatId: "cancel-chat",
      text: "Investigate the timeout and then implement a fix",
    })
    assert.equal(started.route, "supervisor_session")
    assert(started.runId)

    const cancelled = await engine.cancel({ runId: started.runId })
    assert.equal(cancelled.sessionId, started.sessionId)
    assert.ok(cancelled.events.some((event) => event.type === "run_cancelled"))
    assert.ok(
      cancelled.events.some((event) => event.type === "session_cancelled"),
    )

    const approval = started.events.find(
      (event) => event.type === "approval_required",
    )
    assert(approval && approval.type === "approval_required")
    await assert.rejects(() => engine.approve(approval.approvalId))
  })

  test("cancels a persisted supervisor approval", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "ergatai-cancel-recovery-"))
    const engine = new RuntimeEngine(new SessionStore(dataDir))
    const started = await engine.applyInteraction({
      type: "message_submitted",
      chatId: "cancel-recovery-chat",
      text: "Investigate the timeout and then implement a fix",
    })
    const approval = started.events.find(
      (event) => event.type === "approval_required",
    )
    assert(approval && approval.type === "approval_required")

    const restored = new RuntimeEngine(new SessionStore(dataDir))
    await restored.recover()
    const cancelled = await restored.cancel({ runId: started.runId })
    assert.equal(cancelled.sessionId, started.sessionId)
    assert.ok(cancelled.events.some((event) => event.type === "run_cancelled"))
    await assert.rejects(() => restored.approve(approval.approvalId))
  })
})
