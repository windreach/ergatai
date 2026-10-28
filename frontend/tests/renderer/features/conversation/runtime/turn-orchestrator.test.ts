/**
 * Tests for Turn Orchestrator
 *
 * Tests cover:
 * - Send operation flow
 * - Interrupt support
 * - Queue management
 * - Session state transitions
 * - Error handling
 * - Adapter integration
 */

import { describe, it, expect, beforeEach, vi } from "vitest"

// Mock dependencies - these must be defined before imports
vi.mock("@/features/conversation/runtime/conversation-resolver", () => {
  const mockResolve = vi.fn((conv) => Promise.resolve(conv))
  return {
    getConversationResolver: vi.fn(() => ({
      resolve: mockResolve,
    })),
  }
})

vi.mock("@/features/conversation/runtime/agent-runtime-resolver", () => {
  const mockResolve = vi.fn(() =>
    Promise.resolve({
      canStart: true,
      shouldQueue: false,
      reason: null,
    })
  )
  return {
    getAgentRuntimeResolver: vi.fn(() => ({
      resolve: mockResolve,
    })),
  }
})

vi.mock("@/features/conversation/runtime/runtime-session-store", () => {
  const sessions = new Map()
  return {
    getRuntimeSessionStore: vi.fn(() => ({
      ensureSession: vi.fn((id) => {
        if (!sessions.has(id)) {
          sessions.set(id, {
            conversationId: id,
            status: "idle",
            queue: [],
            currentTurnId: null,
          })
        }
        return sessions.get(id)
      }),
      getSession: vi.fn((id) => sessions.get(id) || null),
      setStatus: vi.fn((id, status) => {
        const session = sessions.get(id)
        if (session) session.status = status
      }),
      setCurrentTurnId: vi.fn((id, turnId) => {
        const session = sessions.get(id)
        if (session) session.currentTurnId = turnId
      }),
      getCurrentTurnId: vi.fn((id) => {
        const session = sessions.get(id)
        return session?.currentTurnId || null
      }),
      addQueueItem: vi.fn((id, item) => {
        const session = sessions.get(id)
        if (session) session.queue.push(item)
      }),
      removeQueueItem: vi.fn((id, itemId) => {
        const session = sessions.get(id)
        if (session) {
          session.queue = session.queue.filter((i) => i.id !== itemId)
        }
      }),
      setError: vi.fn(),
    })),
    resetRuntimeSessionStore: vi.fn(() => {
      sessions.clear()
    }),
  }
})

vi.mock("@/features/conversation/runtime/runtime-adapter", () => ({
  getAdapterRegistry: vi.fn(() => ({
    get: vi.fn(() => ({
      sendMessage: vi.fn(() => Promise.resolve()),
      subscribe: vi.fn(() => () => {}),
    })),
  })),
}))

import {
  getTurnOrchestrator,
  resetTurnOrchestrator,
} from "@/features/conversation/runtime/turn-orchestrator"
import { resetRuntimeSessionStore } from "@/features/conversation/runtime/runtime-session-store"

describe("TurnOrchestrator", () => {
  beforeEach(() => {
    resetTurnOrchestrator()
    resetRuntimeSessionStore()
    vi.resetAllMocks()
  })

  describe("Singleton Pattern", () => {
    it("should return the same instance on multiple calls", () => {
      const orchestrator1 = getTurnOrchestrator()
      const orchestrator2 = getTurnOrchestrator()

      expect(orchestrator1).toBe(orchestrator2)
    })

    it("should create new instance after reset", () => {
      const orchestrator1 = getTurnOrchestrator()
      resetTurnOrchestrator()
      const orchestrator2 = getTurnOrchestrator()

      expect(orchestrator1).not.toBe(orchestrator2)
    })
  })

  describe("send()", () => {
    it("should resolve conversation", async () => {
      const orchestrator = getTurnOrchestrator()
      const input = {
        conversation: { conversationId: "conv-1" },
        parts: [{ type: "text", text: "Hello" }],
      }

      await orchestrator.send(input)

      // Should not throw
      expect(orchestrator).toBeDefined()
    })

    it("should return a ticket", async () => {
      const orchestrator = getTurnOrchestrator()
      const input = {
        conversation: { conversationId: "conv-1" },
        parts: [{ type: "text", text: "Hello" }],
      }

      const ticket = await orchestrator.send(input)

      expect(ticket).toBeDefined()
      expect(ticket.ticketId).toBeDefined()
      expect(ticket.conversationId).toBe("conv-1")
    })

    it("should handle interrupt flag", async () => {
      const orchestrator = getTurnOrchestrator()
      const input = {
        conversation: { conversationId: "conv-1" },
        parts: [{ type: "text", text: "Interrupt" }],
        interrupt: true,
      }

      const ticket = await orchestrator.send(input)

      // Should accept interrupt flag
      expect(ticket).toBeDefined()
    })

    it("should generate unique ticket IDs", async () => {
      const orchestrator = getTurnOrchestrator()
      const input = {
        conversation: { conversationId: "conv-1" },
        parts: [{ type: "text", text: "Hello" }],
      }

      const ticket1 = await orchestrator.send(input)
      const ticket2 = await orchestrator.send(input)

      expect(ticket1.ticketId).not.toBe(ticket2.ticketId)
    })
  })

  describe("sendQueuedItem()", () => {
    it("should throw if session not found", async () => {
      const orchestrator = getTurnOrchestrator()

      await expect(
        orchestrator.sendQueuedItem("non-existent", "queue-1")
      ).rejects.toThrow("Session not found")
    })

    it("should throw if queue item not found", async () => {
      const orchestrator = getTurnOrchestrator()

      // First ensure session exists
      await orchestrator.send({
        conversation: { conversationId: "conv-1" },
        parts: [{ type: "text", text: "Hello" }],
      })

      await expect(
        orchestrator.sendQueuedItem("conv-1", "non-existent-queue-id")
      ).rejects.toThrow("Queue item not found")
    })
  })

  describe("Queue Management", () => {
    it("should enqueue when agent cannot start", async () => {
      // Mock agent that cannot start
      const { getAgentRuntimeResolver } = await import(
        "@/features/conversation/runtime/agent-runtime-resolver"
      )
      vi.mocked(getAgentRuntimeResolver).mockReturnValue({
        resolve: vi.fn(() =>
          Promise.resolve({
            canStart: false,
            shouldQueue: true,
            reason: "Agent busy",
          })
        ),
      } as any)

      const orchestrator = getTurnOrchestrator()
      const input = {
        conversation: { conversationId: "conv-1" },
        parts: [{ type: "text", text: "Hello" }],
      }

      const ticket = await orchestrator.send(input)

      expect(ticket.queued).toBe(true)
      expect(ticket.queueItemId).toBeDefined()
    })

    it("should enqueue when forceSend is true", async () => {
      const { getAgentRuntimeResolver } = await import(
        "@/features/conversation/runtime/agent-runtime-resolver"
      )
      vi.mocked(getAgentRuntimeResolver).mockReturnValue({
        resolve: vi.fn(() =>
          Promise.resolve({
            canStart: false,
            shouldQueue: false,
            reason: "Agent busy",
          })
        ),
      } as any)

      const orchestrator = getTurnOrchestrator()
      const input = {
        conversation: { conversationId: "conv-1" },
        parts: [{ type: "text", text: "Hello" }],
        forceSend: true,
      }

      const ticket = await orchestrator.send(input)

      expect(ticket.queued).toBe(true)
    })

    it("should throw when agent cannot start and shouldQueue is false", async () => {
      const { getAgentRuntimeResolver } = await import(
        "@/features/conversation/runtime/agent-runtime-resolver"
      )
      vi.mocked(getAgentRuntimeResolver).mockReturnValue({
        resolve: vi.fn(() =>
          Promise.resolve({
            canStart: false,
            shouldQueue: false,
            reason: "Agent unavailable",
          })
        ),
      } as any)

      const orchestrator = getTurnOrchestrator()
      const input = {
        conversation: { conversationId: "conv-1" },
        parts: [{ type: "text", text: "Hello" }],
      }

      await expect(orchestrator.send(input)).rejects.toThrow(
        "Cannot send message"
      )
    })
  })

  describe("Error Handling", () => {
    it("should handle adapter not found", async () => {
      const { getAdapterRegistry } = await import("@/features/conversation/runtime/runtime-adapter")
      vi.mocked(getAdapterRegistry).mockReturnValue({
        get: vi.fn(() => null),
      } as any)

      const orchestrator = getTurnOrchestrator()
      const input = {
        conversation: { conversationId: "conv-1" },
        parts: [{ type: "text", text: "Hello" }],
      }

      await expect(orchestrator.send(input)).rejects.toThrow(
        "No runtime adapter registered"
      )
    })

    it("should handle conversation resolution failure", async () => {
      const { getConversationResolver } = await import(
        "@/features/conversation/runtime/conversation-resolver"
      )

      // Override mock for this test
      vi.mocked(getConversationResolver).mockReturnValue({
        resolve: vi.fn(() => Promise.reject(new Error("Resolution failed"))),
      } as any)

      const orchestrator = getTurnOrchestrator()
      const input = {
        conversation: { conversationId: "conv-1" },
        parts: [{ type: "text", text: "Hello" }],
      }

      await expect(orchestrator.send(input)).rejects.toThrow(
        "Resolution failed"
      )
    })
  })

  describe("Orchestrator Interface", () => {
    it("should implement all required methods", () => {
      const orchestrator = getTurnOrchestrator()

      expect(typeof orchestrator.send).toBe("function")
      expect(typeof orchestrator.sendQueuedItem).toBe("function")
    })
  })

  describe("Ticket Generation", () => {
    it("should generate ticket with correct format", async () => {
      const orchestrator = getTurnOrchestrator()
      const input = {
        conversation: { conversationId: "conv-1" },
        parts: [{ type: "text", text: "Hello" }],
      }

      const ticket = await orchestrator.send(input)

      expect(ticket.ticketId).toMatch(/^ticket_/)
      expect(ticket.conversationId).toBe("conv-1")
    })

    it("should generate queue item with correct format when queued", async () => {
      const { getAgentRuntimeResolver } = await import(
        "@/features/conversation/runtime/agent-runtime-resolver"
      )
      vi.mocked(getAgentRuntimeResolver).mockReturnValue({
        resolve: vi.fn(() =>
          Promise.resolve({
            canStart: false,
            shouldQueue: true,
            reason: "Busy",
          })
        ),
      } as any)

      const orchestrator = getTurnOrchestrator()
      const input = {
        conversation: { conversationId: "conv-1" },
        parts: [{ type: "text", text: "Hello" }],
      }

      const ticket = await orchestrator.send(input)

      expect(ticket.queueItemId).toMatch(/^queue_/)
    })
  })
})
