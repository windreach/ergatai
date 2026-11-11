import { describe, it, expect } from "vitest"
import { getErrorMessage } from "@/features/file-viewer"

describe("getErrorMessage", () => {
  it("not-found", () => expect(getErrorMessage("not-found")).toBe("File not found"))
  it("too-large", () => expect(getErrorMessage("too-large")).toBe("File is too large to display (max 2 MB)"))
  it("binary", () => expect(getErrorMessage("binary")).toBe("Cannot display binary file"))
  it("unknown", () => expect(getErrorMessage("unknown")).toBe("Failed to load file"))
})
