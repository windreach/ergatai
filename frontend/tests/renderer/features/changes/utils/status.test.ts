import { describe, it, expect } from "vitest"
import { getStatusColor } from "@/features/changes/utils/status"

describe("getStatusColor", () => {
  it("green for added/untracked", () => {
    expect(getStatusColor("added")).toBe("text-green-500")
    expect(getStatusColor("untracked")).toBe("text-green-500")
  })
  it("yellow for modified", () => {
    expect(getStatusColor("modified")).toBe("text-yellow-500")
  })
  it("red for deleted", () => {
    expect(getStatusColor("deleted")).toBe("text-red-500")
  })
  it("blue for renamed", () => {
    expect(getStatusColor("renamed")).toBe("text-blue-500")
  })
  it("purple for copied", () => {
    expect(getStatusColor("copied")).toBe("text-purple-500")
  })
  it("muted for unknown", () => {
    expect(getStatusColor("unknown" as any)).toBe("text-muted-foreground")
  })
})
