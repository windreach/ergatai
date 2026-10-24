import { describe, expect, it } from "vitest"

import {
  agentIdSchema,
  chatIdSchema,
  conversationIdSchema,
  conversationKeySchema,
  messageIdSchema,
  projectIdSchema,
  workspaceIdSchema,
} from "../../../../src/main/lib/validation/ids"

describe("core ID schemas", () => {
  it("validates persisted entity IDs", () => {
    expect(chatIdSchema.safeParse("chat_503994318177_000_0000").success).toBe(true)
    expect(conversationIdSchema.safeParse("conv_503994318188_000_0000").success).toBe(true)
    expect(workspaceIdSchema.safeParse("ws_503994305258_000_0000").success).toBe(true)
    expect(agentIdSchema.safeParse("agent_503994319181_000_0000").success).toBe(true)
    expect(projectIdSchema.safeParse("proj_503994305264_000_0000").success).toBe(true)
  })

  it("rejects IDs with the wrong prefix or shape", () => {
    expect(chatIdSchema.safeParse("conv_503994318188_000_0000").success).toBe(false)
    expect(conversationIdSchema.safeParse("chat_503994318177_000_0000").success).toBe(false)
    expect(workspaceIdSchema.safeParse("/home/yubing/worktree").success).toBe(false)
    expect(agentIdSchema.safeParse("agent_123").success).toBe(false)
    expect(projectIdSchema.safeParse("chat_503994318177_000_0000").success).toBe(false)
  })

  it("accepts persisted numeric message IDs and runtime prompt IDs", () => {
    expect(messageIdSchema.safeParse("2113905554807062528").success).toBe(true)
    expect(messageIdSchema.safeParse("msg_503994352567_000_0000").success).toBe(true)
    expect(messageIdSchema.safeParse("message").success).toBe(false)
  })

  it("separates persisted conversation IDs from runtime conversation keys", () => {
    expect(conversationKeySchema.safeParse("conv_503994318188_000_0000").success).toBe(true)
    expect(conversationKeySchema.safeParse("conv-agent_a-agent_b").success).toBe(true)
    expect(conversationIdSchema.safeParse("conv-agent_a-agent_b").success).toBe(false)
  })

  it("accepts configured agent profile identifiers", () => {
    expect(agentIdSchema.safeParse("claude-code").success).toBe(true)
    expect(agentIdSchema.safeParse("opencode").success).toBe(true)
  })
})
