import { describe, it, expect } from "vitest"
import {
  generatePrMessage,
  generateCommitToPrMessage,
  generateReviewMessage,
} from "@/features/agents/utils/pr-message"

const ctx = { branch: "feat", baseBranch: "main", uncommittedCount: 2, hasUpstream: false }

describe("generatePrMessage", () => {
  it("includes uncommitted count", () => {
    const msg = generatePrMessage(ctx)
    expect(msg).toContain("There are 2 uncommitted changes.")
    expect(msg).toContain("The current branch is feat.")
    expect(msg).toContain("There is no upstream branch yet.")
  })
  it("all committed when zero", () => {
    const msg = generatePrMessage({ ...ctx, uncommittedCount: 0 })
    expect(msg).toContain("All changes are committed.")
  })
  it("pushed when hasUpstream", () => {
    const msg = generatePrMessage({ ...ctx, hasUpstream: true })
    expect(msg).toContain("The branch is already pushed to remote.")
  })
})

describe("generateCommitToPrMessage", () => {
  it("up to date when zero", () => {
    expect(generateCommitToPrMessage({ ...ctx, uncommittedCount: 0 })).toContain("up to date")
  })
  it("includes steps when changes", () => {
    const msg = generateCommitToPrMessage(ctx)
    expect(msg).toContain("2 uncommitted changes")
    expect(msg).toContain("Push to origin")
  })
})

describe("generateReviewMessage", () => {
  it("includes branch info", () => {
    const msg = generateReviewMessage(ctx)
    expect(msg).toContain("current branch is feat")
    expect(msg).toContain("origin/main")
  })
})
