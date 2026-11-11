import { describe, it } from "vitest"
describe("conversation import", () => {
  it("imports conversation", async () => {
    await import("@/features/conversation")
    console.log("IMPORTED CONVERSATION OK")
  }, 30000)
})
