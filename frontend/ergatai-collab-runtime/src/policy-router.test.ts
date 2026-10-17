import assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  normalizeInteraction,
  routeInteraction,
} from "./policy-router"

describe("normalizeInteraction", () => {
  test("trims message text and removes duplicate mentions", () => {
    const interaction = normalizeInteraction({
      type: "message_submitted",
      chatId: "chat-1",
      text: "  Fix the login timeout  ",
      mentions: ["codex", "codex", ""],
      workspaceId: "workspace-1",
    })

    assert.deepEqual(interaction, {
      type: "message_submitted",
      chatId: "chat-1",
      text: "Fix the login timeout",
      mentions: ["codex"],
      workspaceId: "workspace-1",
    })
  })
})

describe("routeInteraction", () => {
  test("routes a short single-agent request as lightweight chat", () => {
    const route = routeInteraction(
      normalizeInteraction({
        type: "message_submitted",
        chatId: "chat-1",
        text: "What is this function doing?",
      }),
      { collaborationMode: "supervisor" },
    )

    assert.equal(route, "lightweight_chat")
  })

  test("routes an actionable request as a single-agent run", () => {
    const route = routeInteraction(
      normalizeInteraction({
        type: "message_submitted",
        chatId: "chat-1",
        text: "Fix the login timeout",
      }),
      { collaborationMode: "supervisor" },
    )

    assert.equal(route, "single_agent_run")
  })

  test("routes a multi-step request as supervisor collaboration", () => {
    const route = routeInteraction(
      normalizeInteraction({
        type: "message_submitted",
        chatId: "chat-1",
        text: "Investigate the timeout and then implement a fix",
      }),
      { collaborationMode: "supervisor" },
    )

    assert.equal(route, "supervisor_session")
  })

  test("routes mentions and Group mode as group collaboration", () => {
    const mention = routeInteraction(
      normalizeInteraction({
        type: "message_submitted",
        chatId: "chat-1",
        text: "hello",
        mentions: ["codex"],
      }),
      { collaborationMode: "supervisor" },
    )
    const groupMode = routeInteraction(
      normalizeInteraction({
        type: "message_submitted",
        chatId: "chat-1",
        text: "hello",
      }),
      { collaborationMode: "group" },
    )

    assert.equal(mention, "group_session")
    assert.equal(groupMode, "group_session")
  })

  test("preserves an explicit DAG session route", () => {
    const route = routeInteraction(
      normalizeInteraction({
        type: "message_submitted",
        chatId: "chat-1",
        text: "continue the workflow",
      }),
      { collaborationMode: "group", hasPersistedDagSession: true },
    )

    assert.equal(route, "dag_import")
  })
})
