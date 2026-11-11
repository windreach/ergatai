import { describe, it, expect, vi, beforeEach } from "vitest"
import { waitForStreamingReady } from "@/features/agents/utils/stream-utils"
import { useStreamingStatusStore } from "@/features/agents/stores/streaming-status-store"

describe("waitForStreamingReady", () => {
  beforeEach(() => {
    useStreamingStatusStore.getState().clearAllStatuses()
    vi.useRealTimers()
  })

  it("resolves immediately when not streaming", async () => {
    await waitForStreamingReady("c1")
    expect(true).toBe(true)
  })

  it("resolves when status becomes ready", async () => {
    useStreamingStatusStore.getState().setStatus("c1", "streaming")
    const promise = waitForStreamingReady("c1")
    // set to ready (removes key)
    setTimeout(() => useStreamingStatusStore.getState().setStatus("c1", "ready"), 10)
    await promise
    expect(true).toBe(true)
  })

  it("times out and resolves anyway", async () => {
    vi.useFakeTimers()
    useStreamingStatusStore.getState().setStatus("c1", "streaming")
    const promise = waitForStreamingReady("c1")
    vi.advanceTimersByTime(30000)
    await promise
    vi.useRealTimers()
    expect(true).toBe(true)
  })
})
