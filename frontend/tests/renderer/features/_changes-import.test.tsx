import { describe, it } from "vitest"
describe("changes import", () => {
  it("imports changes", async () => {
    await import("@/features/changes")
    console.log("IMPORTED CHANGES OK")
  }, 30000)
})
