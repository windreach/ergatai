import { describe, it, expect } from "vitest"
import { cn } from "@/lib/utils"

describe("utils", () => {
  describe("cn (className merger)", () => {
    it("should merge simple class names", () => {
      expect(cn("px-4", "py-2")).toBe("px-4 py-2")
    })

    it("should handle conditional classes", () => {
      expect(cn("base", false && "hidden", "extra")).toBe("base extra")
      expect(cn("base", true && "active", "extra")).toBe("base active extra")
    })

    it("should merge conflicting Tailwind classes", () => {
      // Later classes should override earlier ones
      expect(cn("px-4", "px-2")).toBe("px-2")
      expect(cn("py-4", "py-8")).toBe("py-8")
      expect(cn("text-red-500", "text-blue-500")).toBe("text-blue-500")
    })

    it("should handle undefined and null", () => {
      expect(cn("base", undefined, "extra")).toBe("base extra")
      expect(cn("base", null, "extra")).toBe("base extra")
    })

    it("should handle empty inputs", () => {
      expect(cn()).toBe("")
      expect(cn("")).toBe("")
      expect(cn(undefined)).toBe("")
    })

    it("should handle arrays of classes", () => {
      expect(cn(["px-4", "py-2"])).toBe("px-4 py-2")
      expect(cn("base", ["px-4", "py-2"])).toBe("base px-4 py-2")
    })

    it("should handle objects with boolean values", () => {
      expect(cn({ active: true, disabled: false })).toBe("active")
      expect(cn("base", { active: true, hidden: false })).toBe("base active")
    })

    it("should handle complex combinations", () => {
      expect(cn("base", ["px-4", "py-2"], { active: true }, undefined)).toBe(
        "base px-4 py-2 active"
      )
    })

    it("should handle Tailwind responsive prefixes", () => {
      expect(cn("px-4", "md:px-8", "lg:px-12")).toBe("px-4 md:px-8 lg:px-12")
    })

    it("should handle Tailwind state variants", () => {
      expect(cn("hover:bg-blue-500", "focus:ring-2")).toBe(
        "hover:bg-blue-500 focus:ring-2"
      )
    })

    it("should handle dark mode classes", () => {
      expect(cn("bg-white", "dark:bg-gray-900")).toBe("bg-white dark:bg-gray-900")
    })

    it("should merge duplicate base classes correctly", () => {
      expect(cn("px-4 py-2", "px-6")).toBe("py-2 px-6")
      expect(cn("text-sm font-bold", "text-lg")).toBe("font-bold text-lg")
    })
  })
})
