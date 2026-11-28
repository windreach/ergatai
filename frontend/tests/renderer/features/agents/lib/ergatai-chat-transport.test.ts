import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/i18n", () => ({
  default: { t: (key: string) => key },
}))

vi.mock("@/features/agents/lib/conversation-runtime-agent-storage", () => ({
  conversationRuntimeAgentStorage: { set: vi.fn() },
}))

vi.mock("@/features/agents/lib/ergatai-agent-manager", () => ({
  getOrCreateActiveAgent: vi.fn(),
}))

vi.mock("@/features/agents/lib/agent-session-api", () => ({
  promptConversation: vi.fn(),
}))

vi.mock("@/contexts/TRPCProvider", () => ({
  getQueryClient: vi.fn(() => null),
}))

vi.mock("@/lib/trpc", () => ({
  trpcClient: {
    ergatai: {
      subscribeAgentStream: { subscribe: vi.fn() },
      updateConversation: { mutate: vi.fn() },
    },
  },
}))

vi.mock("@/features/agents/stores/conversation-store", () => ({
  useAgentConversationStore: {
    getState: () => ({ updateConversationName: vi.fn() }),
  },
}))

vi.mock("@/features/agents/lib/extension-meta-store", () => ({
  updateExtensionMeta: vi.fn(),
}))

vi.mock("@/features/agents/lib/agent-terminal-store", () => ({
  applyAgentTerminalExtension: vi.fn(),
}))

vi.mock("@/features/agents/lib/subagent-message-store", () => ({
  appendSubagentMessage: vi.fn(),
  upsertSubagentRun: vi.fn(),
  updateSubagentRunState: vi.fn(),
  clearSubagentState: vi.fn(),
}))

vi.mock("@/features/conversation", () => ({
  getRuntimeSessionStore: vi.fn(() => ({
    getSession: vi.fn(() => null),
    updateContextUsage: vi.fn(),
  })),
}))

vi.mock("@/lib/jotai-store", () => ({
  appStore: { set: vi.fn() },
}))

vi.mock("@/features/agents/atoms", () => ({
  agentStatusLineAtomFamily: vi.fn(() => "status-line"),
}))

vi.mock("@/shared/id", () => ({
  isPersistedMessageId: vi.fn(() => false),
}))

vi.mock("@/shared/mention-title", () => ({
  promptToTitle: vi.fn(() => "New Conversation"),
  mentionsToReadableText: vi.fn((value: string) => value),
}))

vi.mock("@/shared/chat-error", () => ({
  normalizeChatError: vi.fn((input) => input),
}))

import { ErgataiChatTransport } from "@/features/agents/lib/ergatai-chat-transport"
import { promptConversation } from "@/features/agents/lib/agent-session-api"
import { trpcClient } from "@/lib/trpc"

const flushAsyncWork = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function createTransport() {
  return new ErgataiChatTransport({
    chatId: "chat-1",
    conversationId: "conv-1",
    agentId: "agent-1",
    mode: "agent",
  })
}

function createMessages() {
  return [
    {
      id: "msg-local-1",
      role: "user" as const,
      parts: [{ type: "text" as const, text: "Hello" }],
    },
  ]
}

describe("ErgataiChatTransport prompt startup", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(promptConversation).mockResolvedValue({})
    vi.mocked(trpcClient.ergatai.subscribeAgentStream.subscribe).mockReturnValue({
      unsubscribe: vi.fn(),
    } as any)
  })

  it("does not publish a prompt when aborted while waiting for stream_ready", async () => {
    const controller = new AbortController()
    const stream = await createTransport().sendMessages({
      messages: createMessages(),
      abortSignal: controller.signal,
    })

    controller.abort()
    await flushAsyncWork()

    expect(promptConversation).not.toHaveBeenCalled()
    const reader = stream.getReader()
    expect(await reader.read()).toEqual({
      value: { type: "start" },
      done: false,
    })
    expect(await reader.read()).toEqual({
      value: { type: "finish" },
      done: false,
    })
  })

  it("does not publish a prompt after the stream fails before stream_ready", async () => {
    vi.mocked(trpcClient.ergatai.subscribeAgentStream.subscribe).mockImplementation(
      ((_input, handlers) => {
        handlers.onError(new Error("SSE disconnected"))
        return { unsubscribe: vi.fn() }
      }) as any,
    )

    const stream = await createTransport().sendMessages({
      messages: createMessages(),
    })
    await flushAsyncWork()

    expect(promptConversation).not.toHaveBeenCalled()
    const chunks = await Array.fromAsync(stream as any)
    expect(chunks.some((chunk) => chunk.type === "error")).toBe(true)
  })

  it("ignores a stale done until the new turn_started marker arrives", async () => {
    let handlers: any
    vi.mocked(trpcClient.ergatai.subscribeAgentStream.subscribe).mockImplementation(
      ((_input, callbacks) => {
        handlers = callbacks
        handlers.onData({ type: "stream_ready" })
        return { unsubscribe: vi.fn() }
      }) as any,
    )

    const stream = await createTransport().sendMessages({
      messages: createMessages(),
    })
    await flushAsyncWork()

    handlers.onData({ type: "done" })
    handlers.onData({ type: "turn_started", turn_id: "turn-new" })
    handlers.onData({ type: "text", role: "assistant", delta: "new reply" })
    handlers.onData({ type: "done" })

    const chunks = await Array.fromAsync(stream as any)
    expect(chunks).toContainEqual({
      type: "text-delta",
      id: expect.any(String),
      delta: "new reply",
    })
    expect(chunks.at(-1)).toEqual({ type: "finish" })
  })

  it("replays a pending terminal event when turn_started never arrives", async () => {
    vi.useFakeTimers()
    try {
      let handlers: any
      vi.mocked(trpcClient.ergatai.subscribeAgentStream.subscribe).mockImplementation(
        ((_input, callbacks) => {
          handlers = callbacks
          handlers.onData({ type: "stream_ready" })
          return { unsubscribe: vi.fn() }
        }) as any,
      )

      const stream = await createTransport().sendMessages({
        messages: createMessages(),
      })
      await vi.advanceTimersByTimeAsync(0)
      handlers.onData({ type: "text", role: "assistant", delta: "legacy reply" })
      handlers.onData({ type: "done" })
      await vi.advanceTimersByTimeAsync(10_000)

      const chunks = await Array.fromAsync(stream as any)
      expect(chunks).toContainEqual({
        type: "text-delta",
        id: expect.any(String),
        delta: "legacy reply",
      })
      expect(chunks.at(-1)).toEqual({ type: "finish" })
    } finally {
      vi.useRealTimers()
    }
  })
})
