import { describe, expect, it } from "vitest"

import { attachSideCopyProjectionsToTrace } from "@/features/details-sidebar/lib/side-copy-projection"

describe("attachSideCopyProjectionsToTrace", () => {
  it("moves a side copy into its matching send_message tool call", () => {
    const sideCopyId = "side_copy_1"
    const canonicalMessageId = "msg_canonical_1"
    const result = attachSideCopyProjectionsToTrace([
      {
        id: "request_1",
        sequence: 0,
        role: "agent",
        parts: [{ type: "text", text: "hello" }],
        metadata: { correlationId: "corr_1" },
      },
      {
        id: sideCopyId,
        sequence: 1,
        role: "assistant",
        parts: [{ type: "text", text: "reply text" }],
        content: "reply text",
        metadata: { correlationId: "corr_1" },
        projectionKind: "side_copy",
        originMessageId: canonicalMessageId,
      },
      {
        id: "trace_1",
        sequence: 2,
        role: "assistant",
        parts: [
          {
            type: "tool-Ergatai_MCP_Tools_send_message",
            toolCallId: "call_1",
            state: "result",
            input: { message: "reply text" },
            output: {
              output: JSON.stringify({
                status: "queued",
                message_id: canonicalMessageId,
              }),
            },
          },
        ],
        metadata: { correlationId: "corr_1" },
      },
    ])

    expect(result.map(message => message.id)).toEqual(["request_1", "trace_1"])
    const toolPart = result[1]!.parts[0] as {
      sideMessage?: { text?: string; originMessageId?: string }
    }
    expect(toolPart.sideMessage?.text).toBe("reply text")
    expect(toolPart.sideMessage?.originMessageId).toBe(canonicalMessageId)
  })

  it("keeps an unmatched side copy visible instead of silently dropping it", () => {
    const sideCopy = {
      id: "side_copy_unmatched",
      sequence: 1,
      role: "assistant",
      parts: [{ type: "text", text: "reply text" }],
      content: "reply text",
      metadata: {},
      projectionKind: "side_copy",
      originMessageId: "msg_missing",
    }
    const trace = {
      id: "trace_1",
      sequence: 2,
      role: "assistant",
      parts: [],
      metadata: {},
    }

    const result = attachSideCopyProjectionsToTrace([sideCopy, trace])
    expect(result.map(message => message.id)).toEqual([
      "side_copy_unmatched",
      "trace_1",
    ])
  })
})
