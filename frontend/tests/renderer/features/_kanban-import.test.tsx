import { describe, it } from "vitest"
describe("kanban import", () => {
  it("imports kanban", async () => {
    await import("@/features/kanban")
    console.log("IMPORTED KANBAN OK")
  }, 30000)
})
