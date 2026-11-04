import { describe, it } from "vitest"
describe("sidebar import", () => {
  it("imports sidebar", async () => {
    await import("@/features/sidebar/agents-conversations-sidebar")
    console.log("IMPORTED SIDEBAR OK")
  }, 30000)
})
