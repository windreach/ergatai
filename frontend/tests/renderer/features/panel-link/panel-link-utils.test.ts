import { describe, it, expect } from "vitest"
import { normalizePanelLinkRuntimeEvent } from "@/features/panel-link/runtime"
import { createPanelLinkScopeKey, createPanelLinkScopeState } from "@/features/panel-link/store"

describe("createPanelLinkScopeKey", () => {
  it("defaults", () => {
    expect(createPanelLinkScopeKey({})).toBe("default-workspace::new-chat")
  })
  it("uses provided", () => {
    expect(createPanelLinkScopeKey({ chatId: "c1", workspaceId: "w1" })).toBe("w1::c1")
  })
})

describe("createPanelLinkScopeState", () => {
  it("empty state", () => {
    const s = createPanelLinkScopeState()
    expect(s.activeTarget).toBeNull()
    expect(s.panels).toEqual({})
  })
})

describe("normalizePanelLinkRuntimeEvent", () => {
  it("agent-status-changed", () => {
    const cmd = normalizePanelLinkRuntimeEvent({
      type: "agent-status-changed",
      agentId: "a1",
      chatId: "c1",
      status: "running",
    })
    expect(cmd.type).toBe("sync-panel-target")
    expect(cmd.panelId).toBe("side-chat")
    expect(cmd.target?.kind).toBe("agent")
    expect(cmd.target?.id).toBe("c1:a1")
  })
  it("active-file-changed", () => {
    const cmd = normalizePanelLinkRuntimeEvent({
      type: "active-file-changed",
      chatId: "c1",
      path: "/f.ts",
    })
    expect(cmd.panelId).toBe("diff")
    expect(cmd.target?.kind).toBe("file")
    expect(cmd.target?.path).toBe("/f.ts")
  })
  it("terminal-focused", () => {
    const cmd = normalizePanelLinkRuntimeEvent({
      type: "terminal-focused",
      chatId: "c1",
      terminalId: "t1",
    })
    expect(cmd.panelId).toBe("terminal")
    expect(cmd.target?.kind).toBe("terminal")
  })
  it("side-chat-changed", () => {
    const cmd = normalizePanelLinkRuntimeEvent({
      type: "side-chat-changed",
      chatId: "c1",
      sideChatId: "sc1",
    })
    expect(cmd.panelId).toBe("side-chat")
    expect(cmd.target?.kind).toBe("chat")
    expect(cmd.target?.id).toBe("sc1")
  })
})
