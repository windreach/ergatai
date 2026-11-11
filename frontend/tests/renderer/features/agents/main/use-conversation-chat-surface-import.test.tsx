import { describe, it } from "vitest"

describe("useConversationChatSurface import", () => {
  it("imports the hook", async () => {
    const mod = await import("@/features/agents")
    expect(typeof mod.useConversationChatSurface).toBe("function")
  }, 30000)
})
