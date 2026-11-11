import { describe, it, expect } from "vitest"
import { formatTimeAgo } from "@/lib/utils/format-time-ago"

describe("formatTimeAgo", () => {
  it("returns now for undefined", () => expect(formatTimeAgo(undefined)).toBe("now"))
  it("returns minutes for recent", () => {
    const d = new Date(Date.now() - 5 * 60 * 1000)
    expect(formatTimeAgo(d)).toBe("5m")
  })
  it("returns hours", () => {
    const d = new Date(Date.now() - 3 * 60 * 60 * 1000)
    expect(formatTimeAgo(d)).toBe("3h")
  })
  it("returns days", () => {
    const d = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    expect(formatTimeAgo(d)).toBe("2d")
  })
})
