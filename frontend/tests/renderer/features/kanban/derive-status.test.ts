import { describe, it, expect } from "vitest"
import { deriveWorkspaceStatus } from "@/features/kanban/lib/derive-status"

const deps = (over: Partial<{
  loading: string[]
  questions: string[]
  approvals: string[]
}> = {}) => ({
  workspacesLoading: new Set(over.loading ?? []),
  workspacesWithPendingQuestions: new Set(over.questions ?? []),
  workspacesWithPendingApprovals: new Set(over.approvals ?? []),
})

describe("deriveWorkspaceStatus", () => {
  it("needs-input for pending question", () => {
    expect(deriveWorkspaceStatus("c1", deps({ questions: ["c1"] }))).toBe("needs-input")
  })
  it("needs-input for pending approval", () => {
    expect(deriveWorkspaceStatus("c1", deps({ approvals: ["c1"] }))).toBe("needs-input")
  })
  it("in-progress when loading", () => {
    expect(deriveWorkspaceStatus("c1", deps({ loading: ["c1"] }))).toBe("in-progress")
  })
  it("needs-input takes priority over loading", () => {
    expect(deriveWorkspaceStatus("c1", deps({ loading: ["c1"], questions: ["c1"] }))).toBe("needs-input")
  })
  it("done otherwise", () => {
    expect(deriveWorkspaceStatus("c1", deps())).toBe("done")
  })
})
