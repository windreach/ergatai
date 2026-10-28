/**
 * Tests for Runtime Sequence Persistence
 *
 * Tests cover:
 * - Reading persisted sequences from localStorage
 * - Writing sequences to localStorage
 * - Removing persisted sequences
 * - Error handling for localStorage failures
 * - Edge cases (invalid values, negative numbers, NaN)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import {
  readPersistedSequence,
  persistSequence,
  removePersistedSequence,
} from "@/features/conversation/runtime/runtime-sequence-persistence"

describe("RuntimeSequencePersistence", () => {
  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe("readPersistedSequence", () => {
    it("should return null when no value is stored", () => {
      const result = readPersistedSequence("conv-1")
      expect(result).toBeNull()
    })

    it("should return parsed number when valid value is stored", () => {
      localStorage.setItem("ergatai:runtime:sequence:conv-1", "42")
      const result = readPersistedSequence("conv-1")
      expect(result).toBe(42)
    })

    it("should return 0 when stored value is '0'", () => {
      localStorage.setItem("ergatai:runtime:sequence:conv-1", "0")
      const result = readPersistedSequence("conv-1")
      expect(result).toBe(0)
    })

    it("should return null for negative numbers", () => {
      localStorage.setItem("ergatai:runtime:sequence:conv-1", "-5")
      const result = readPersistedSequence("conv-1")
      expect(result).toBeNull()
    })

    it("should return null for NaN", () => {
      localStorage.setItem("ergatai:runtime:sequence:conv-1", "not-a-number")
      const result = readPersistedSequence("conv-1")
      expect(result).toBeNull()
    })

    it("should return null for Infinity", () => {
      localStorage.setItem("ergatai:runtime:sequence:conv-1", "Infinity")
      const result = readPersistedSequence("conv-1")
      expect(result).toBeNull()
    })

    it("should return null for empty string", () => {
      localStorage.setItem("ergatai:runtime:sequence:conv-1", "")
      const result = readPersistedSequence("conv-1")
      expect(result).toBeNull()
    })

    it("should handle floating point numbers by truncating", () => {
      localStorage.setItem("ergatai:runtime:sequence:conv-1", "42.7")
      const result = readPersistedSequence("conv-1")
      // parseInt truncates to 42
      expect(result).toBe(42)
    })

    it("should return null when localStorage throws", () => {
      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
      const getItemSpy = vi.spyOn(localStorage, "getItem").mockImplementation(() => {
        throw new Error("localStorage error")
      })

      const result = readPersistedSequence("conv-1")
      expect(result).toBeNull()
      expect(consoleSpy).toHaveBeenCalled()

      getItemSpy.mockRestore()
    })

    it("should use correct storage key format", () => {
      localStorage.setItem("ergatai:runtime:sequence:test-conv", "100")
      const result = readPersistedSequence("test-conv")
      expect(result).toBe(100)
    })

    it("should handle special characters in conversationId", () => {
      const conversationId = "conv-with-special-chars_123!@#"
      localStorage.setItem(
        `ergatai:runtime:sequence:${conversationId}`,
        "99",
      )
      const result = readPersistedSequence(conversationId)
      expect(result).toBe(99)
    })
  })

  describe("persistSequence", () => {
    it("should store sequence as string in localStorage", () => {
      persistSequence("conv-1", 42)
      const stored = localStorage.getItem("ergatai:runtime:sequence:conv-1")
      expect(stored).toBe("42")
    })

    it("should store 0 correctly", () => {
      persistSequence("conv-1", 0)
      const stored = localStorage.getItem("ergatai:runtime:sequence:conv-1")
      expect(stored).toBe("0")
    })

    it("should overwrite existing value", () => {
      persistSequence("conv-1", 10)
      persistSequence("conv-1", 20)
      const stored = localStorage.getItem("ergatai:runtime:sequence:conv-1")
      expect(stored).toBe("20")
    })

    it("should handle large sequence numbers", () => {
      persistSequence("conv-1", Number.MAX_SAFE_INTEGER)
      const stored = localStorage.getItem("ergatai:runtime:sequence:conv-1")
      expect(stored).toBe(String(Number.MAX_SAFE_INTEGER))
    })

    it("should not throw when localStorage throws", () => {
      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
      const setItemSpy = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
        throw new Error("localStorage error")
      })

      expect(() => persistSequence("conv-1", 42)).not.toThrow()
      expect(consoleSpy).toHaveBeenCalled()

      setItemSpy.mockRestore()
    })

    it("should use correct storage key format", () => {
      persistSequence("test-conv", 100)
      const stored = localStorage.getItem("ergatai:runtime:sequence:test-conv")
      expect(stored).toBe("100")
    })
  })

  describe("removePersistedSequence", () => {
    it("should remove stored sequence from localStorage", () => {
      localStorage.setItem("ergatai:runtime:sequence:conv-1", "42")
      removePersistedSequence("conv-1")
      const stored = localStorage.getItem("ergatai:runtime:sequence:conv-1")
      expect(stored).toBeNull()
    })

    it("should not throw when removing non-existent key", () => {
      expect(() => removePersistedSequence("non-existent")).not.toThrow()
    })

    it("should not throw when localStorage throws", () => {
      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
      const removeItemSpy = vi.spyOn(localStorage, "removeItem").mockImplementation(() => {
        throw new Error("localStorage error")
      })

      expect(() => removePersistedSequence("conv-1")).not.toThrow()
      expect(consoleSpy).toHaveBeenCalled()

      removeItemSpy.mockRestore()
    })

    it("should use correct storage key format", () => {
      localStorage.setItem("ergatai:runtime:sequence:test-conv", "100")
      removePersistedSequence("test-conv")
      const stored = localStorage.getItem("ergatai:runtime:sequence:test-conv")
      expect(stored).toBeNull()
    })
  })

  describe("Integration scenarios", () => {
    it("should persist and read back the same value", () => {
      persistSequence("conv-1", 42)
      const result = readPersistedSequence("conv-1")
      expect(result).toBe(42)
    })

    it("should handle multiple conversations independently", () => {
      persistSequence("conv-1", 10)
      persistSequence("conv-2", 20)
      persistSequence("conv-3", 30)

      expect(readPersistedSequence("conv-1")).toBe(10)
      expect(readPersistedSequence("conv-2")).toBe(20)
      expect(readPersistedSequence("conv-3")).toBe(30)
    })

    it("should remove only the specified conversation's sequence", () => {
      persistSequence("conv-1", 10)
      persistSequence("conv-2", 20)

      removePersistedSequence("conv-1")

      expect(readPersistedSequence("conv-1")).toBeNull()
      expect(readPersistedSequence("conv-2")).toBe(20)
    })

    it("should handle sequence updates correctly", () => {
      persistSequence("conv-1", 1)
      expect(readPersistedSequence("conv-1")).toBe(1)

      persistSequence("conv-1", 2)
      expect(readPersistedSequence("conv-1")).toBe(2)

      persistSequence("conv-1", 3)
      expect(readPersistedSequence("conv-1")).toBe(3)
    })
  })
})
