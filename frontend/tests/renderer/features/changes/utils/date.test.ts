import { describe, it, expect } from "vitest"
import { formatRelativeDate } from "@/features/changes/utils/date"

describe("formatRelativeDate", () => {
  it("returns 'just now' for now", () => {
    expect(formatRelativeDate(new Date())).toBe("just now")
  })

  it("returns minutes for < 1 hour", () => {
    const d = new Date(Date.now() - 5 * 60 * 1000)
    expect(formatRelativeDate(d)).toBe("5m ago")
  })

  it("returns hours for < 24 hours", () => {
    const d = new Date(Date.now() - 3 * 60 * 60 * 1000)
    expect(formatRelativeDate(d)).toBe("3h ago")
  })

  it("returns days for < 7 days", () => {
    const d = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    expect(formatRelativeDate(d)).toBe("2d ago")
  })

  it("returns locale date for >= 7 days", () => {
    const d = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
    expect(formatRelativeDate(d)).toBe(d.toLocaleDateString())
  })
})
