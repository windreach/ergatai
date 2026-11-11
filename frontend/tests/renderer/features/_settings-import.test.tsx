import { describe, it } from "vitest"
describe("settings import", () => {
  it("imports settings", async () => {
    await import("@/features/settings")
    console.log("IMPORTED SETTINGS OK")
  }, 30000)
})
