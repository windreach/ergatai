import { describe, it } from "vitest"
describe("hooks import", () => {
  it("imports hooks", async () => {
    await import("@/features/hooks")
    console.log("IMPORTED HOOKS OK")
  }, 30000)
})
