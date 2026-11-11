import { describe, it } from "vitest"
describe("panel-link import", () => {
  it("imports panel-link", async () => {
    await import("@/features/panel-link")
    console.log("IMPORTED PANEL-LINK OK")
  }, 30000)
})
