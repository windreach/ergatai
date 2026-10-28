/**
 * Basic tests for AgentsConversationsSidebar component
 *
 * Note: Full component testing is complex due to many dependencies (jotai atoms, tRPC, etc.)
 * These tests verify the component can be imported and basic structure exists.
 */

import { describe, it, expect, vi } from "vitest"

// Mock trpc before any imports to prevent electronTRPC initialization errors
vi.mock("@/lib/trpc", () => ({
  trpc: {},
  trpcClient: {},
}))

vi.mock("@/lib/ipc-link", () => ({
  ipcLink: vi.fn(),
}))

describe("AgentsConversationsSidebar", () => {
  it("should be importable", async () => {
    // This test verifies the component module can be loaded without errors
    const module = await import(
      "@/features/sidebar/agents-conversations-sidebar"
    )
    expect(module.AgentsConversationsSidebar).toBeDefined()
    expect(typeof module.AgentsConversationsSidebar).toBe("function")
  })

  it("should export a React component", async () => {
    const module = await import(
      "@/features/sidebar/agents-conversations-sidebar"
    )
    // React components are functions
    expect(module.AgentsConversationsSidebar.prototype).toBeDefined()
  })
})
