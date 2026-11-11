import { describe, it, expect } from "vitest"
import { PROJECTION_KINDS } from "@/lib/projection-kinds"

describe("PROJECTION_KINDS", () => {
  it("has canonical/side_copy/agent_output", () => {
    expect(PROJECTION_KINDS.CANONICAL).toBe("canonical")
    expect(PROJECTION_KINDS.SIDE_COPY).toBe("side_copy")
    expect(PROJECTION_KINDS.AGENT_OUTPUT).toBe("agent_output")
  })
})
