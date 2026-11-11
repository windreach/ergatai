import { describe, it, expect, beforeEach } from "vitest"
import { getConversationResolver, resetConversationResolver } from "@/features/conversation/runtime/conversation-resolver"

describe("ConversationResolver", () => {
  beforeEach(() => resetConversationResolver())

  it("normal mode default provider", async () => {
    const r = await getConversationResolver().resolve({
      chatId: "c1",
      conversationId: "conv1",
    } as any)
    expect(r.mode).toBe("normal")
    expect(r.provider).toBe("claude-code")
    expect(r.backendConversationId).toBe("conv1")
    expect(r.agentId).toBeNull()
  })

  it("uses backendConversationId when provided", async () => {
    const r = await getConversationResolver().resolve({
      chatId: "c1",
      conversationId: "conv1",
      backendConversationId: "b1",
    } as any)
    expect(r.backendConversationId).toBe("b1")
  })

  it("group mode", async () => {
    const r = await getConversationResolver().resolve({
      chatId: "c1",
      conversationId: "conv1",
      source: "group",
    } as any)
    expect(r.mode).toBe("group")
  })

  it("agent mode when agentId", async () => {
    const r = await getConversationResolver().resolve({
      chatId: "c1",
      conversationId: "conv1",
      agentId: "a1",
    } as any)
    expect(r.mode).toBe("agent")
    expect(r.agentId).toBe("a1")
  })

  it("custom provider", async () => {
    const r = await getConversationResolver().resolve({
      chatId: "c1",
      conversationId: "conv1",
      provider: "codex",
    } as any)
    expect(r.provider).toBe("codex")
  })

  it("throws on null input", async () => {
    await expect(getConversationResolver().resolve(null as any)).rejects.toThrow()
  })
})
