import { describe, it, expect } from "vitest"
import { getAppOption } from "@/components/open-in-button"

describe("getAppOption", () => {
  it("returns known app", () => {
    expect(getAppOption("cursor").label).toBe("Cursor")
  })
  it("falls back for unknown", () => {
    const opt = getAppOption("finder" as any)
    expect(opt).toBeDefined()
  })
})
