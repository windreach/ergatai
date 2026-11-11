import { describe, it, expect } from "vitest"
import { cn } from "../../../src/renderer/lib/utils"

describe("cn", () => {
  it("merges classes", () => {
    expect(cn("a", "b")).toBe("a b")
  })
  it("resolves tailwind conflicts", () => {
    expect(cn("p-2", "p-4")).toBe("p-4")
  })
  it("handles falsy", () => {
    expect(cn("a", false, null, undefined, "b")).toBe("a b")
  })
})
