import { describe, it } from "vitest"
describe("agent import", () => {
  it("imports agents", async () => {
    await import("@/features/agents")
    console.log("IMPORTED AGENTS OK")
  }, 30000)
})
