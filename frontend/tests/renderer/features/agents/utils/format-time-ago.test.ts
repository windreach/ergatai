import { describe, it, expect } from "vitest"
import { formatTimeAgo, formatTimeAgoShort } from "@/features/agents/utils/format-time-ago"

describe("formatTimeAgo", () => {
  it("just now for null/undefined", () => {
    expect(formatTimeAgo(null)).toBe("just now")
    expect(formatTimeAgo(undefined)).toBe("just now")
  })
  it("just now for future", () => {
    expect(formatTimeAgo(new Date(Date.now() + 1000))).toBe("just now")
  })
  it("minutes", () => {
    const d = new Date(Date.now() - 5 * 60 * 1000)
    expect(formatTimeAgo(d)).toBe("5 minutes ago")
  })
  it("single minute", () => {
    const d = new Date(Date.now() - 60 * 1000)
    expect(formatTimeAgo(d)).toBe("1 minute ago")
  })
  it("hours", () => {
    const d = new Date(Date.now() - 3 * 60 * 60 * 1000)
    expect(formatTimeAgo(d)).toBe("3 hours ago")
  })
  it("days", () => {
    const d = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    expect(formatTimeAgo(d)).toBe("2 days ago")
  })
  it("weeks", () => {
    const d = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
    expect(formatTimeAgo(d)).toBe("1 week ago")
  })
  it("months", () => {
    const d = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000)
    expect(formatTimeAgo(d)).toBe("1 month ago")
  })
  it("years", () => {
    const d = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000)
    expect(formatTimeAgo(d)).toBe("1 year ago")
  })
  it("number timestamp", () => {
    const ts = Date.now() - 2 * 60 * 1000
    expect(formatTimeAgo(ts)).toBe("2 minutes ago")
  })
  it("iso string", () => {
    const iso = new Date(Date.now() - 2 * 60 * 1000).toISOString()
    expect(formatTimeAgo(iso)).toBe("2 minutes ago")
  })
})

describe("formatTimeAgoShort", () => {
  it("now for null", () => {
    expect(formatTimeAgoShort(null)).toBe("now")
  })
  it("minutes", () => {
    const d = new Date(Date.now() - 5 * 60 * 1000)
    expect(formatTimeAgoShort(d)).toBe("5m")
  })
  it("hours", () => {
    const d = new Date(Date.now() - 3 * 60 * 60 * 1000)
    expect(formatTimeAgoShort(d)).toBe("3h")
  })
  it("days", () => {
    const d = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    expect(formatTimeAgoShort(d)).toBe("2d")
  })
  it("weeks", () => {
    const d = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
    expect(formatTimeAgoShort(d)).toBe("1w")
  })
})
