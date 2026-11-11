import { describe, it, expect } from "vitest"
import {
  chatIdSchema,
  conversationIdSchema,
  workspaceIdSchema,
  agentIdSchema,
  isSnowflakeEntityId,
} from "../../../src/main/lib/validation/ids"
// note: isSafeHttpUrl is in url-utils, imported separately below

describe("chatIdSchema", () => {
  it("accepts valid chat id", () => {
    expect(chatIdSchema.safeParse("chat_1234567890123_1_1").success).toBe(true)
  })
  it("rejects invalid", () => {
    expect(chatIdSchema.safeParse("chat_bad").success).toBe(false)
    expect(chatIdSchema.safeParse("123").success).toBe(false)
  })
})

describe("agentIdSchema", () => {
  it("accepts runtime agent id with snowflake", () => {
    expect(agentIdSchema.safeParse("agent_1234567890123_1_1").success).toBe(true)
  })
  it("accepts profile identifier", () => {
    expect(agentIdSchema.safeParse("claude-code").success).toBe(true)
  })
  it("rejects invalid", () => {
    expect(agentIdSchema.safeParse("bad!").success).toBe(false)
    expect(agentIdSchema.safeParse("").success).toBe(false)
  })
})

describe("isSnowflakeEntityId", () => {
  it("validates", () => {
    expect(isSnowflakeEntityId("1234567890123_1_1")).toBe(true)
    expect(isSnowflakeEntityId("nope")).toBe(false)
  })
})
