import { describe, expect, it } from "vitest"
import {
  agentTriggerChars,
  matchAgentTriggers,
  normalizeAgentTriggers,
} from "@/features/mentions/native-triggers"

const triggers = normalizeAgentTriggers([
  {
    id: "codex-dollar",
    agentId: "codex",
    char: "$",
    kind: "command",
    pattern: "(^|\\s)\\$([A-Za-z0-9_-]+)$",
    execution: "passthrough",
    source: "manual",
  },
])

describe("native triggers", () => {
  it("accepts backend snake_case agent ids", () => {
    const normalized = normalizeAgentTriggers([
      {
        id: "claude-at",
        agent_id: "claude",
        char: "@",
        kind: "context",
        pattern: "(^|\\s)@([^\\s]+)$",
        execution: "passthrough",
        source: "adapter",
      },
    ])
    expect(normalized[0]?.agentId).toBe("claude")
  })

  it("normalizes only valid single-character allowlist entries", () => {
    expect(triggers).toHaveLength(1)
    expect(agentTriggerChars(triggers)).toEqual(["$"])
    expect(
      normalizeAgentTriggers([
        { id: "bad", char: "@@", kind: "command", pattern: "a$", execution: "passthrough" },
        { id: "bad-regex", char: "#", kind: "keyword", pattern: "([a", execution: "passthrough" },
      ]),
    ).toEqual([])
  })

  it("matches only registered triggers at the caret", () => {
    const match = matchAgentTriggers("please run $explain", triggers)
    expect(match).toHaveLength(1)
    expect(match[0].query).toBe("explain")
    expect(match[0].matchedText).toBe(" $explain")
  })

  it("does not match unregistered or non-caret symbols", () => {
    expect(matchAgentTriggers("path:/tmp/$foo", triggers)).toEqual([])
    expect(matchAgentTriggers("$foo more text", triggers)).toEqual([])
  })

  it("keeps unmatched syntax as ordinary text", () => {
    expect(agentTriggerChars(normalizeAgentTriggers([]))).toEqual([])
    expect(matchAgentTriggers("@unknown and /unknown", [])).toEqual([])
  })
})
