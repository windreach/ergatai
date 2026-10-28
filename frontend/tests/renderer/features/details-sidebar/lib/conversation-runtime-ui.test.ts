import { describe, expect, it } from "vitest"
import { buildRuntimeMessages } from "@/features/details-sidebar/lib/conversation-runtime-ui"

describe("buildRuntimeMessages", () => {
  it("renders thinking deltas before the runtime turn completes", () => {
    const messages = buildRuntimeMessages({
      conversationId: "conv-1",
      turnId: "turn-1",
      status: "streaming",
      lastSequence: 3,
      events: [
        {
          sequence: 0,
          event: {
            type: "conversation_message",
            message_id: "msg-request",
            role: "agent",
            message_type: "request",
            content: "hello",
            timestamp_ms: 1,
          },
        },
        { sequence: 1, event: { type: "thinking", role: "assistant", delta: "thi" } },
        { sequence: 2, event: { type: "thinking", role: "assistant", delta: "nking" } },
      ],
    } as any)

    expect(messages).toHaveLength(2)
    expect(messages[0]?.id).toBe("msg-request")
    expect(messages[1]?.id).toBe("runtime-conv-1-turn-1-0")

    const reasoning = (messages[1]?.parts as any[]).find((part) => part.type === "reasoning")
    expect(reasoning?.input?.text).toBe("thinking")
  })
})
