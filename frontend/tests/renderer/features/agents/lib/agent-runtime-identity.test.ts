import { describe, expect, it } from "vitest"
import {
  getAgentProfileName,
  resolveAgentRuntimeId,
  type AgentRegistration,
} from "@/features/agents/lib/agent-contract-api"
import { createChatAgentLogos } from "@/features/agents/atoms"

const customAgent: AgentRegistration = {
  id: "profile-1",
  profileName: "agentcode",
  name: "agentcode",
  runtimeId: "opencode",
  startupCommand: "opencode acp",
}

describe("custom agent runtime identity", () => {
  it("resolves the runtime logo from the custom profile name", () => {
    expect(resolveAgentRuntimeId([customAgent], "agentcode")).toBe("opencode")
  })

  it("keeps the built-in runtime for legacy registrations without profileName", () => {
    const legacy: AgentRegistration = {
      id: "profile-2",
      name: "agentcode",
      runtimeId: "opencode",
      startupCommand: "opencode acp",
    }

    expect(getAgentProfileName(legacy)).toBe("agentcode")
    expect(resolveAgentRuntimeId([legacy], "agentcode")).toBe("opencode")
  })

  it("stores runtimeId in chat logos so other pages can render the runtime icon", () => {
    const logos = createChatAgentLogos(
      ["agentcode"],
      [{ id: "agentcode", name: "agentcode" }],
      [customAgent],
    )

    expect(logos).toEqual([
      {
        agentId: "agentcode",
        runtimeId: "opencode",
        name: "agentcode",
        avatarUrl: undefined,
      },
    ])
  })
})
