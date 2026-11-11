import { describe, it } from "vitest"
describe("details-sidebar import", () => {
  it("imports details-sidebar", async () => {
    await import("@/features/details-sidebar")
    console.log("IMPORTED DETAILS-SIDEBAR OK")
  }, 30000)
})
