import { describe, it } from "vitest"
describe("onboarding import", () => {
  it("imports onboarding", async () => {
    await import("@/features/onboarding")
    console.log("IMPORTED ONBOARDING OK")
  }, 30000)
})
