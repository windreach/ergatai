import { describe, it } from "vitest"
describe("layout import", () => {
  it("imports layout", async () => {
    await import("@/features/layout")
    console.log("IMPORTED LAYOUT OK")
  }, 30000)
})
