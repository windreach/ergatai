import { describe, it } from "vitest"
describe("task-board import", () => {
  it("imports task-board", async () => {
    await import("@/features/task-board")
    console.log("IMPORTED TASK-BOARD OK")
  }, 30000)
})
