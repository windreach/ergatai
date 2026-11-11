import { describe, it, expect } from "vitest"
import { pluralize } from "@/lib/utils/pluralize"

describe("pluralize", () => {
  it("singular for 1", () => expect(pluralize(1, "item")).toBe("item"))
  it("plural default", () => expect(pluralize(2, "item")).toBe("items"))
  it("custom plural", () => expect(pluralize(2, "child", "children")).toBe("children"))
  it("zero is plural", () => expect(pluralize(0, "item")).toBe("items"))
})
