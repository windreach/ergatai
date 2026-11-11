import { describe, it } from "vitest"
describe("file-viewer import", () => {
  it("imports file-viewer", async () => {
    await import("@/features/file-viewer")
    console.log("IMPORTED FILE-VIEWER OK")
  }, 30000)
})
