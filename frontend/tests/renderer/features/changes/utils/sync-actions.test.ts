import { describe, it, expect } from "vitest"
import { getSyncActionKind } from "@/features/changes/utils/sync-actions"

describe("getSyncActionKind", () => {
  it("loading when sync status loading", () => {
    expect(getSyncActionKind({ isSyncStatusLoading: true, pullCount: 5 })).toBe("loading")
  })

  it("publish when no upstream", () => {
    expect(getSyncActionKind({ hasUpstream: false })).toBe("publish")
  })

  it("pull when pullCount > 0", () => {
    expect(getSyncActionKind({ pullCount: 3 })).toBe("pull")
  })

  it("push when pushCount > 0 and no pull", () => {
    expect(getSyncActionKind({ pushCount: 2 })).toBe("push")
  })

  it("none when nothing to sync", () => {
    expect(getSyncActionKind({})).toBe("none")
  })

  it("pull takes precedence over push", () => {
    expect(getSyncActionKind({ pullCount: 1, pushCount: 1 })).toBe("pull")
  })
})
