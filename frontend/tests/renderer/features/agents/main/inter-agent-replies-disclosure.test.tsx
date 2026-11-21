import { describe, expect, it, vi, beforeEach } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

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
      subscribeConversationRuntime: {
        subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })),
      },
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
const HOST_CONVERSATION_ID = "conv_host"

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

// Shape persisted by the backend (agent_output_persistence.rs): terminal ACP
// tools use state "result" and the MCP result is stored under `stdout`.
const PERSISTED_TARGET_AGENT_ID = "agent_506420019732_000_0000"
const PERSISTED_TARGET_AGENT_RAW_ID = 2124079514442006528

function makePersistedMessageParts() {
  return [
    {
      type: "tool-mcp__Ergatai_MCP_Tools__send_message",
      toolCallId: "call_persisted_1",
      state: "result",
      input: {
        target_agent_id: "opencode",
        message: "hello from A",
        message_type: "request",
      },
      output: {
        stdout: JSON.stringify({
          status: "queued",
          target_agent: PERSISTED_TARGET_AGENT_ID,
          message_id: REPLY_TO_MESSAGE_ID,
          correlation_id: CORRELATION_ID,
        }),
      },
    },
  ]
}

function makeReplyMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: "R1",
    conversationId: HOST_CONVERSATION_ID,
    sequence: 1,
    role: "respagent",
    fromAgentId: "agent_B",
    fromAgentName: "opencode",
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

function setupMocks() {
  vi.mocked(trpc.ergatai.getAgentBindings.useQuery).mockReturnValue({
    data: [BINDING],
    isLoading: false,
    error: null,
  } as any)

  queryMock.mockImplementation(() => Promise.resolve([makeReplyMessage()]))
}

function renderDisclosure(
  parts: unknown[] = makeMessageParts(),
  hostConversationId = HOST_CONVERSATION_ID,
) {
  return render(
    <InterAgentRepliesDisclosure
      message={{ parts, conversationId: hostConversationId }}
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

describe("InterAgentRepliesDisclosure MCP reply rendering", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupMocks()
    __resetConversationPipelinesForTests()
  })

  it("does not render without a host respagent reply", async () => {
    queryMock.mockImplementation(() => Promise.resolve([]))
    renderDisclosure()

    await waitFor(() =>
      expect(queryMock).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: HOST_CONVERSATION_ID }),
      ),
    )
    expect(screen.queryByRole("button")).toBeNull()
  })

  it("renders only the MCP-delivered respagent reply from the host conversation", async () => {
    queryMock.mockImplementation(() => Promise.resolve([makeReplyMessage()]))
    renderDisclosure()

    await waitFor(() => expect(getTriggerButton()).toBeTruthy())
    fireEvent.click(getTriggerButton())

    await waitFor(() => expect(screen.getByText("B 的回复第一版")).toBeTruthy())
  })

  it("renders a reply when send_message is persisted with state=result and stdout output", async () => {
    vi.mocked(trpc.ergatai.getAgentBindings.useQuery).mockReturnValue({
      data: [
        {
          agentId: PERSISTED_TARGET_AGENT_ID,
          agentName: "opencode",
          agentCommand: "opencode",
          conversationId: "conv_persisted_B",
        },
      ],
      isLoading: false,
      error: null,
    } as any)

    queryMock.mockImplementation(() =>
      Promise.resolve([
        makeReplyMessage({
          // Persisted sender fields: numeric Snowflake id + typed runtime id.
          fromAgentId: PERSISTED_TARGET_AGENT_RAW_ID,
          fromAgentName: PERSISTED_TARGET_AGENT_ID,
        }),
      ]),
    )

    renderDisclosure(makePersistedMessageParts())

    await waitFor(() => expect(getTriggerButton()).toBeTruthy())
    fireEvent.click(getTriggerButton())
    await waitFor(() => expect(screen.getByText("B 的回复第一版")).toBeTruthy())

    expect(queryMock).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: HOST_CONVERSATION_ID }),
    )
  })

  it("correlates persisted stdout results to the matching reply only", async () => {
    vi.mocked(trpc.ergatai.getAgentBindings.useQuery).mockReturnValue({
      data: [
        {
          agentId: PERSISTED_TARGET_AGENT_ID,
          agentName: "opencode",
          agentCommand: "opencode",
          conversationId: "conv_persisted_B",
        },
      ],
      isLoading: false,
      error: null,
    } as any)

    queryMock.mockImplementation(() =>
      Promise.resolve([
        makeReplyMessage({
          id: "R1",
          fromAgentId: PERSISTED_TARGET_AGENT_RAW_ID,
          fromAgentName: PERSISTED_TARGET_AGENT_ID,
          parts: [{ type: "text", text: "匹配的回复" }],
          metadata: {
            correlationId: CORRELATION_ID,
            replyToMessageId: REPLY_TO_MESSAGE_ID,
          },
        }),
        makeReplyMessage({
          id: "R2",
          sequence: 2,
          fromAgentId: PERSISTED_TARGET_AGENT_RAW_ID,
          fromAgentName: PERSISTED_TARGET_AGENT_ID,
          parts: [{ type: "text", text: "无关的回复" }],
          metadata: {
            correlationId: "corr_other",
            replyToMessageId: "msg_other",
          },
        }),
      ]),
    )

    renderDisclosure(makePersistedMessageParts())

    await waitFor(() => expect(getTriggerButton()).toBeTruthy())
    fireEvent.click(getTriggerButton())

    await waitFor(() => expect(screen.getByText("匹配的回复")).toBeTruthy())
    expect(screen.queryByText("无关的回复")).toBeNull()
  })

  it("uses the explicit host conversation id when the UI message has none", async () => {
    render(
      <InterAgentRepliesDisclosure
        message={{ parts: makeMessageParts() }}
        chatId="chat_123"
        hostConversationId={HOST_CONVERSATION_ID}
      />,
    )

    await waitFor(() => expect(getTriggerButton()).toBeTruthy())
    expect(queryMock).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: HOST_CONVERSATION_ID }),
    )
  })

  it("ignores non-respagent assistant messages in the host conversation", async () => {
    queryMock.mockImplementation(() =>
      Promise.resolve([makeReplyMessage({ role: "assistant" })]),
    )
    renderDisclosure()

    await waitFor(() => expect(queryMock).toHaveBeenCalled())
    expect(screen.queryByRole("button")).toBeNull()
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
