import { describe, expect, it, vi, beforeEach } from "vitest"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"

// ---------------------------------------------------------------------------
// Mocks – must be registered before importing the component under test.
// ---------------------------------------------------------------------------

vi.mock("../../../../../src/renderer/lib/trpc", () => ({
  trpc: {
    ergatai: {
      getAgentBindings: {
        useQuery: vi.fn(),
      },
    },
  },
  trpcClient: {
    ergatai: {
      listConversationMessages: { query: vi.fn() },
      subscribeAgentStream: { subscribe: vi.fn() },
    },
  },
}))

// Avoid loading real Shiki (wasm, heavy) – we only need the async swap to be
// observable so the test can assert on the pre-highlight → post-highlight
// content replacement that users perceive as a "flash".
vi.mock("../../../../../src/renderer/lib/themes/shiki-theme-loader", () => ({
  highlightCode: vi.fn(
    async (code: string) => `<span data-shiki-highlighted="true">${code}</span>`,
  ),
}))

import { trpc, trpcClient } from "../../../../../src/renderer/lib/trpc"
import {
  __resetConversationPipelinesForTests,
} from "../../../../../src/renderer/features/agents/hooks/use-conversation-messages"
import { InterAgentRepliesDisclosure } from "../../../../../src/renderer/features/agents/main/inter-agent-replies-disclosure"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TOOL_CALL_ID = "toolu_test_1"
const CORRELATION_ID = "corr_1"
const REPLY_TO_MESSAGE_ID = "msg_out_1"

function makeMessageParts() {
  return [
    {
      type: "tool-mcp__Ergatai_MCP_Tools__send_message",
      toolCallId: TOOL_CALL_ID,
      state: "output-available",
      input: {
        target_agent_id: "opencode",
        message: "hello from A",
      },
      output: [
        {
          type: "text",
          text: JSON.stringify({
            target_agent: "agent_B",
            message_id: REPLY_TO_MESSAGE_ID,
            correlation_id: CORRELATION_ID,
          }),
        },
      ],
    },
  ]
}

function makeReplyMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: "R1",
    conversationId: "conv_B",
    sequence: 1,
    role: "assistant",
    messageType: "response",
    parts: [{ type: "text", text: "B 的回复第一版" }],
    metadata: {
      correlationId: CORRELATION_ID,
      replyToMessageId: REPLY_TO_MESSAGE_ID,
    },
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  }
}

const BINDING = {
  agentId: "agent_B",
  agentName: "opencode",
  agentCommand: "opencode",
  conversationId: "conv_B",
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const queryMock = trpcClient.ergatai.listConversationMessages
  .query as unknown as ReturnType<typeof vi.fn>
const subscribeMock = trpcClient.ergatai.subscribeAgentStream
  .subscribe as unknown as ReturnType<typeof vi.fn>

let streamHandler: {
  onData?: (event: { type: string; delta?: string }) => void
  onError?: (err: unknown) => void
  onComplete?: () => void
} = {}

function setupMocks() {
  vi.mocked(trpc.ergatai.getAgentBindings.useQuery).mockReturnValue({
    data: [BINDING],
    isLoading: false,
    error: null,
  } as any)

  queryMock.mockImplementation(() => Promise.resolve([makeReplyMessage()]))

  subscribeMock.mockImplementation((_input: unknown, handlers: typeof streamHandler) => {
    streamHandler = handlers
    return { unsubscribe: vi.fn() }
  })
}

function renderDisclosure() {
  return render(
    <InterAgentRepliesDisclosure
      message={{ parts: makeMessageParts() }}
      chatId="chat_123"
    />,
  )
}

function getTriggerButton() {
  // The disclosure trigger is the only button rendered by the component.
  return screen.getByRole("button", { name: /opencode/ })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("InterAgentRepliesDisclosure streaming races", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    streamHandler = {}
    setupMocks()
    __resetConversationPipelinesForTests()
  })

  it("streams the reply content live via agent-stream deltas", async () => {
    renderDisclosure()

    // Expand once the shared pipeline has delivered the matching history.
    await waitFor(() => expect(getTriggerButton()).toBeTruthy())
    const triggerBefore = getTriggerButton()
    fireEvent.click(triggerBefore)

    // The turn streams: deltas grow the preview message live (smoothed).
    act(() => {
      streamHandler.onData?.({ type: "text", delta: "正在打" })
    })
    await waitFor(() => expect(screen.getByText("正在打")).toBeTruthy())

    act(() => {
      streamHandler.onData?.({ type: "text", delta: "字的内容" })
    })
    await waitFor(() => expect(screen.getByText("正在打字的内容")).toBeTruthy())
    expect(getTriggerButton()).toBe(triggerBefore)
  })

  it("keeps the disclosure mounted and stable across turn completion", async () => {
    renderDisclosure()

    await waitFor(() => expect(getTriggerButton()).toBeTruthy())
    const triggerBefore = getTriggerButton()
    fireEvent.click(triggerBefore)

    // Live preview grows...
    act(() => {
      streamHandler.onData?.({ type: "text", delta: "流式回复" })
    })
    await waitFor(() => expect(screen.getByText("流式回复")).toBeTruthy())
    expect(getTriggerButton()).toBe(triggerBefore)

    // Turn completes; the durable copy replaces the preview without flicker.
    act(() => {
      streamHandler.onData?.({ type: "done", stop_reason: "end_turn" })
      streamHandler.onComplete?.()
    })
    await waitFor(
      () => {
        expect(screen.getByText("B 的回复第一版")).toBeTruthy()
      },
      { timeout: 3000 },
    )
    expect(screen.queryByText("__streaming_preview__")).toBeNull()
    expect(getTriggerButton()).toBe(triggerBefore)
  })

  it("does not mount any disclosure until content exists, then stays stable", async () => {
    queryMock.mockImplementation(() => Promise.resolve([]))
    renderDisclosure()

    // No replies yet → no disclosure at all (no empty button).
    await waitFor(() => expect(queryMock).toHaveBeenCalled())
    expect(screen.queryByRole("button")).toBeNull()

    // The live turn starts streaming → disclosure appears exactly once.
    act(() => {
      streamHandler.onData?.({ type: "text", delta: "第一条实时回复" })
    })
    await waitFor(() => expect(getTriggerButton()).toBeTruthy())

    const trigger = getTriggerButton()
    fireEvent.click(trigger)

    act(() => {
      streamHandler.onData?.({ type: "text", delta: "（继续）" })
    })
    // Same node — no unmount/remount flicker on subsequent updates.
    expect(getTriggerButton()).toBe(trigger)
    await waitFor(() => {
      const content = document.querySelector("[class*='min-w-64']")
      expect(content?.textContent).toContain("第一条实时回复（继续）")
    })
  })
})

describe("ChatMarkdownRenderer code highlight flash", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("does NOT swap code block innerHTML after initial mount", async () => {
    const { ChatMarkdownRenderer } = await import(
      "../../../../../src/renderer/components/chat-markdown-renderer"
    )

    render(
      <ChatMarkdownRenderer
        content={"看这段代码：\n\n```js\nconst a = 1\n```\n"}
        size="sm"
      />,
    )

    const code = document.querySelector("pre code")
    expect(code).not.toBeNull()
    const initialHtml = code!.innerHTML

    // The initial paint must already be the final content. If highlighting
    // completes asynchronously and replaces innerHTML, users see a flash.
    await waitFor(() => {
      expect(code!.innerHTML).toBe(initialHtml)
    })
  })
})
