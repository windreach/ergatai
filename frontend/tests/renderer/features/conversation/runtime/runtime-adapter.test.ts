/**
 * Runtime Adapter Tests
 *
 * Tests for the ConversationRuntimeAdapter and AdapterRegistry.
 */

import { describe, it, expect, beforeEach, vi } from "vitest"
import {
  getAdapterRegistry,
  resetAdapterRegistry,
  type ConversationRuntimeAdapter,
} from "@/renderer/features/conversation/runtime/runtime-adapter"

describe("AdapterRegistry", () => {
  beforeEach(() => {
    resetAdapterRegistry()
  })

  describe("register", () => {
    it("should register an adapter for a conversation", () => {
      const registry = getAdapterRegistry()
      const adapter: ConversationRuntimeAdapter = {
        sendMessage: vi.fn(),
        stop: vi.fn(),
      }

      registry.register("conv-1", adapter)

      expect(registry.has("conv-1")).toBe(true)
      expect(registry.get("conv-1")).toBe(adapter)
    })

    it("should return unregister function", () => {
      const registry = getAdapterRegistry()
      const adapter: ConversationRuntimeAdapter = {
        sendMessage: vi.fn(),
        stop: vi.fn(),
      }

      const unregister = registry.register("conv-1", adapter)
      expect(registry.has("conv-1")).toBe(true)

      unregister()
      expect(registry.has("conv-1")).toBe(false)
      expect(registry.get("conv-1")).toBeNull()
    })

    it("should allow multiple adapters for different conversations", () => {
      const registry = getAdapterRegistry()
      const adapter1: ConversationRuntimeAdapter = {
        sendMessage: vi.fn(),
        stop: vi.fn(),
      }
      const adapter2: ConversationRuntimeAdapter = {
        sendMessage: vi.fn(),
        stop: vi.fn(),
      }

      registry.register("conv-1", adapter1)
      registry.register("conv-2", adapter2)

      expect(registry.get("conv-1")).toBe(adapter1)
      expect(registry.get("conv-2")).toBe(adapter2)
    })

    it("should overwrite adapter if registered again", () => {
      const registry = getAdapterRegistry()
      const adapter1: ConversationRuntimeAdapter = {
        sendMessage: vi.fn(),
        stop: vi.fn(),
      }
      const adapter2: ConversationRuntimeAdapter = {
        sendMessage: vi.fn(),
        stop: vi.fn(),
      }

      registry.register("conv-1", adapter1)
      expect(registry.get("conv-1")).toBe(adapter1)

      registry.register("conv-1", adapter2)
      expect(registry.get("conv-1")).toBe(adapter2)
    })
  })

  describe("get", () => {
    it("should return null for unregistered conversation", () => {
      const registry = getAdapterRegistry()
      expect(registry.get("non-existent")).toBeNull()
    })

    it("should return the registered adapter", () => {
      const registry = getAdapterRegistry()
      const adapter: ConversationRuntimeAdapter = {
        sendMessage: vi.fn(),
        stop: vi.fn(),
      }

      registry.register("conv-1", adapter)
      expect(registry.get("conv-1")).toBe(adapter)
    })
  })

  describe("has", () => {
    it("should return false for unregistered conversation", () => {
      const registry = getAdapterRegistry()
      expect(registry.has("non-existent")).toBe(false)
    })

    it("should return true for registered conversation", () => {
      const registry = getAdapterRegistry()
      const adapter: ConversationRuntimeAdapter = {
        sendMessage: vi.fn(),
        stop: vi.fn(),
      }

      registry.register("conv-1", adapter)
      expect(registry.has("conv-1")).toBe(true)
    })

    it("should return false after unregister", () => {
      const registry = getAdapterRegistry()
      const adapter: ConversationRuntimeAdapter = {
        sendMessage: vi.fn(),
        stop: vi.fn(),
      }

      const unregister = registry.register("conv-1", adapter)
      expect(registry.has("conv-1")).toBe(true)

      unregister()
      expect(registry.has("conv-1")).toBe(false)
    })
  })
})
