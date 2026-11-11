import { describe, it } from "vitest"
describe("mentions import", () => {
  it("imports mentions", async () => {
    await import("@/features/mentions")
    console.log("IMPORTED MENTIONS OK")
  }, 30000)
})
