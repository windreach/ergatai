import { describe, expect, it } from "vitest"

import { mapSessionMessage } from "@/features/details-sidebar/lib/session-message-mapper"

describe("mapSessionMessage", () => {
  it("maps a persisted agent message with structured content", () => {
    const result = mapSessionMessage({
      id: "msg_1",
      sequence: 1,
      role: "agent",
      parts: [{ type: "text", text: "raw" }],
      content: "structured reply",
      metadata: { agentId: "agent_a", agentName: "Agent A", messageType: "response" },
      turnId: "turn_1",
    })

    expect(result.id).toBe("msg_1")
    expect(result.role).toBe("agent")
    expect(result.content).toBe("structured reply")
    expect(result.senderAgentId).toBe("agent_a")
    expect(result.senderAgentName).toBe("Agent A")
    expect(result.messageType).toBe("response")
    expect(result.turnId).toBe("turn_1")
  })

  it("falls back to part text when content is empty", () => {
    const result = mapSessionMessage({
      id: "msg_2",
      sequence: 2,
      role: "assistant",
      parts: [{ type: "text", text: "hello" }, { type: "text", text: "world" }],
      content: null,
      metadata: null,
    })

    expect(result.content).toBe("hello\n\nworld")
    expect(result.role).toBe("assistant")
  })

  it("extracts reasoning text from reasoning parts", () => {
    const result = mapSessionMessage({
      id: "msg_3",
      sequence: 3,
      role: "assistant",
      parts: [
        { type: "reasoning", text: "thinking" },
        { type: "text", text: "answer" },
      ],
      content: null,
      metadata: null,
    })

    expect(result.reasoning).toBe("thinking")
    expect(result.content).toBe("answer")
  })
})