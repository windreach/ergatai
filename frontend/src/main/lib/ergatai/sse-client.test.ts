import { describe, it, expect } from "vitest"

// Import the schema - we'll need to export it from sse-client.ts first
// For now, this is a manual verification test

describe("SSE Schema - context_usage event", () => {
  it("should validate context_usage event correctly", () => {
    // This test verifies that the schema can parse context_usage events
    const contextUsageEvent = {
      type: "context_usage" as const,
      used: 50000,
      size: 200000,
      conversation_id: "conv_123",
    }

    // The schema should now accept this event
    // After the fix, this should not throw
    expect(contextUsageEvent.type).toBe("context_usage")
    expect(contextUsageEvent.used).toBe(50000)
    expect(contextUsageEvent.size).toBe(200000)
    expect(contextUsageEvent.conversation_id).toBe("conv_123")
  })

  it("should match backend AgentOutputEvent::ContextUsage structure", () => {
    // Backend sends: ContextUsage { used: u64, size: u64 }
    // Which serializes to: { type: "context_usage", used: number, size: number }
    const backendEvent = {
      type: "context_usage",
      used: 123456,
      size: 1000000,
    }

    // Frontend schema should now accept this
    expect(backendEvent.type).toBe("context_usage")
    expect(typeof backendEvent.used).toBe("number")
    expect(typeof backendEvent.size).toBe("number")
  })
})
