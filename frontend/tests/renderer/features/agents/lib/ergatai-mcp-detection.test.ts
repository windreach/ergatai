import { describe, expect, it } from "vitest"

import {
  getSendMessageArgs,
  isErgataiSendMessagePart,
} from "../../../../../src/renderer/features/agents/lib/ergatai-mcp-detection"

// Shape persisted by code-mode agents (e.g. OpenCode's `execute` wrapper):
// the real MCP call is only visible in `input.code` and the result metadata.
function makeCodeModePart(overrides: Record<string, unknown> = {}) {
  return {
    type: "tool-execute",
    toolCallId: "call_code_mode_1",
    toolKind: null,
    state: "result",
    input: {
      code: `const result = await tools.Ergatai_MCP_Tools.send_message({
  target_agent_id: "agentcode",
  message: "Hello! This is a test message.",
  message_type: "request"
});
return result;`,
    },
    output: {
      metadata: {
        toolCalls: [
          {
            tool: "Ergatai_MCP_Tools.send_message",
            status: "completed",
            input: {
              target_agent_id: "agentcode",
              message: "Hello! This is a test message.",
              message_type: "request",
            },
          },
        ],
      },
      stdout: JSON.stringify({
        status: "queued",
        target_agent: "agent_506504053763_000_0000",
        message_id: "msg_1",
        correlation_id: "corr_1",
      }),
    },
    ...overrides,
  }
}

describe("Ergatai MCP send_message detection", () => {
  it("recognizes code-mode execute parts via result metadata", () => {
    expect(isErgataiSendMessagePart(makeCodeModePart())).toBe(true)
    expect(getSendMessageArgs(makeCodeModePart())).toMatchObject({
      target_agent_id: "agentcode",
      message: "Hello! This is a test message.",
      message_type: "request",
    })
  })

  it("recognizes code-mode execute parts without result metadata", () => {
    const part = makeCodeModePart({ output: undefined, state: "input-available" })
    expect(isErgataiSendMessagePart(part)).toBe(true)
    expect(getSendMessageArgs(part)).toMatchObject({
      target_agent_id: "agentcode",
      message_type: "request",
    })
  })

  it("supports target_conversation_id in code-mode calls", () => {
    const part = makeCodeModePart({
      output: undefined,
      input: {
        code: `tools.Ergatai_MCP_Tools.send_message({ target_conversation_id: "conv_123", message: "hi" })`,
      },
    })
    expect(getSendMessageArgs(part)).toMatchObject({
      target_conversation_id: "conv_123",
      message: "hi",
    })
  })

  it("still recognizes direct MCP tool parts", () => {
    const part = {
      type: "tool-mcp__Ergatai_MCP_Tools__send_message",
      toolCallId: "call_direct",
      state: "output-available",
      input: { target_agent_id: "opencode", message: "hello" },
    }
    expect(isErgataiSendMessagePart(part)).toBe(true)
    expect(getSendMessageArgs(part)).toMatchObject({
      target_agent_id: "opencode",
      message: "hello",
    })
  })

  it("does not misclassify unrelated execute parts", () => {
    const part = makeCodeModePart({
      input: { code: "const result = await tools.Other.do_something({ x: 1 })" },
      output: { metadata: { toolCalls: [{ tool: "Other.do_something" }] } },
    })
    expect(isErgataiSendMessagePart(part)).toBe(false)
    expect(getSendMessageArgs(part)).toBeNull()
  })
})
