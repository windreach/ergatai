import { describe, it, expect } from "vitest"
import { createPanelLinkScopeKey, createPanelLinkScopeState, normalizePanelLinkRuntimeEvent } from "@/features/panel-link"

describe("panel-link", () => {
  it("scope key defaults", () => {
    expect(createPanelLinkScopeKey({})).toBe("default-workspace::new-chat")
  })

  it("scope key custom", () => {
    expect(createPanelLinkScopeKey({ chatId: "c1", workspaceId: "w1" })).toBe("w1::c1")
  })

  it("initial scope state", () => {
    const s = createPanelLinkScopeState()
    expect(s.activeTarget).toBeNull()
    expect(s.panels).toEqual({})
  })

  it("normalize agent-status-changed", () => {
    const cmd = normalizePanelLinkRuntimeEvent({
      type: "agent-status-changed",
      chatId: "c",
      agentId: "a",
      workspaceId: "w",
      status: "running",
      requestId: "r",
    } as any)
    expect(cmd.type).toBe("sync-panel-target")
    expect(cmd.panelId).toBe("side-chat")
  })
})
