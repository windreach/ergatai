import { describe, it } from "vitest"
describe("terminal import", () => {
  it("imports terminal", async () => {
    await import("@/features/terminal")
    console.log("IMPORTED TERMINAL OK")
  }, 30000)
})
