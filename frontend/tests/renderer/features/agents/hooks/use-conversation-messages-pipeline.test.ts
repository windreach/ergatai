import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"

vi.mock("../../../../../src/renderer/lib/trpc", () => ({
  trpc: {
    ergatai: {
      getAgentBindings: { useQuery: vi.fn() },
    },
  },
  trpcClient: {
    ergatai: {
      listConversationMessages: { query: vi.fn() },
      subscribeAgentStream: { subscribe: vi.fn() },
    },
  },
}))

import { trpcClient } from "../../../../../src/renderer/lib/trpc"
import {
  useConversationMessages,
  __resetConversationPipelinesForTests,
} from "../../../../../src/renderer/features/agents/hooks/use-conversation-messages"

type HookMessage = ReturnType<typeof useConversationMessages>["messages"][number]

function makeMessage(overrides: Partial<HookMessage> = {}): HookMessage {
  return {
    id: "R1",
    conversationId: "conv_p3",
    sequence: 1,
    role: "assistant",
    parts: [{ type: "text", text: "持久化的完整回复" }],
    metadata: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  } as HookMessage
}

type StreamEvent = {
  type: string
  delta?: string
  id?: string
  name?: string
  input?: unknown
  output?: unknown
  error?: string
}

// -- test harness -----------------------------------------------------------

const queryMock = trpcClient.ergatai.listConversationMessages
  .query as unknown as ReturnType<typeof vi.fn>
const subscribeMock = trpcClient.ergatai.subscribeAgentStream
  .subscribe as unknown as ReturnType<typeof vi.fn>

let streamHandler: {
  onData?: (event: StreamEvent) => void
  onError?: (err: unknown) => void
  onComplete?: () => void
} = {}
let unsubscribeFn: ReturnType<typeof vi.fn>

function setHistory(messages: HookMessage[] | Error) {
  queryMock.mockImplementation(() =>
    messages instanceof Error ? Promise.reject(messages) : Promise.resolve(messages),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  streamHandler = {}
  unsubscribeFn = vi.fn()
  subscribeMock.mockImplementation((_input: unknown, handlers: typeof streamHandler) => {
    streamHandler = handlers
    return { unsubscribe: unsubscribeFn }
  })
  __resetConversationPipelinesForTests()
})

afterEach(() => {
  __resetConversationPipelinesForTests()
  vi.useRealTimers()
})

describe("shared conversation pipeline: streaming preview", () => {
  it("grows the preview message from text deltas (smoothed typewriter)", async () => {
    vi.useFakeTimers()
    setHistory([])
    const { result } = renderHook(() =>
      useConversationMessages("conv_p3", "agent_B"),
    )
    await vi.advanceTimersByTimeAsync(0)

    act(() => {
      streamHandler.onData?.({ type: "text", delta: "你" })
    })
    await vi.advanceTimersByTimeAsync(40)
    expect(result.current.messages).toHaveLength(1)
    expect(result.current.messages[0].parts).toEqual([{ type: "text", text: "你" }])
    expect(result.current.messages[0].metadata).toEqual({ streaming: true })

    // A burst of deltas is revealed progressively, not dumped at once.
    act(() => {
      streamHandler.onData?.({ type: "text", delta: "你好世界再见！" })
    })
    await vi.advanceTimersByTimeAsync(32)
    const partial = (result.current.messages[0].parts as Array<{ text: string }>)[0].text
    const fullText = "你" + "你好世界再见！"
    expect(partial.length).toBeLessThan(fullText.length)
    expect(fullText.startsWith(partial)).toBe(true)

    await vi.advanceTimersByTimeAsync(500)
    expect(result.current.messages[0].parts).toEqual([{ type: "text", text: fullText }])
  })

  it("builds tool call parts from tool events", async () => {
    setHistory([])
    const { result } = renderHook(() =>
      useConversationMessages("conv_p3", "agent_B"),
    )
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    act(() => {
      streamHandler.onData?.({ type: "tool_call_start", id: "t1", name: "send_message", input: {} })
      streamHandler.onData?.({
        type: "tool_call_complete",
        id: "t1",
        name: "send_message",
        input: { message: "hi" },
        output: [{ type: "text", text: "queued" }],
      })
    })

    const parts = result.current.messages[0].parts as Array<Record<string, unknown>>
    expect(parts).toHaveLength(1)
    expect(parts[0].state).toBe("output-available")
    expect(parts[0].input).toEqual({ message: "hi" })
  })

  it("after done: refetches history and replaces the preview with the persisted message", async () => {
    vi.useFakeTimers()
    // First load: empty. After done: the persisted reply.
    let history: HookMessage[] = []
    queryMock.mockImplementation(() => Promise.resolve(history))
    const { result } = renderHook(() =>
      useConversationMessages("conv_p3", "agent_B"),
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(result.current.isLoading).toBe(false)

    act(() => {
      streamHandler.onData?.({ type: "text", delta: "流式内容" })
    })
    await vi.advanceTimersByTimeAsync(64)
    expect(result.current.messages).toHaveLength(1)
    expect(result.current.messages[0].id).toBe("__streaming_preview__")

    act(() => {
      streamHandler.onData?.({ type: "done", stop_reason: "end_turn" })
    })

    // Persisted copy lands; the pipeline refetches history after ~1s.
    history = [makeMessage()]
    await vi.advanceTimersByTimeAsync(2_000)

    expect(queryMock).toHaveBeenCalledTimes(2)
    expect(result.current.messages).toHaveLength(1)
    expect(result.current.messages[0].id).toBe("R1")
    expect(result.current.messages[0].parts).toEqual([{ type: "text", text: "持久化的完整回复" }])
  })

  it("reconnects the agent stream after done so later turns keep streaming", async () => {
    vi.useFakeTimers()
    setHistory([])
    renderHook(() => useConversationMessages("conv_p3", "agent_B"))
    await vi.advanceTimersByTimeAsync(0)
    expect(subscribeMock).toHaveBeenCalledTimes(1)

    act(() => {
      streamHandler.onData?.({ type: "text", delta: "第一轮" })
      streamHandler.onData?.({ type: "done", stop_reason: "end_turn" })
    })
    // The tRPC procedure completes the subscription right after `done`.
    act(() => {
      streamHandler.onComplete?.()
    })
    // → auto reconnect.
    await vi.advanceTimersByTimeAsync(500)
    expect(subscribeMock).toHaveBeenCalledTimes(2)

    // Next turn streams through the fresh subscription.
    act(() => {
      streamHandler.onData?.({ type: "text", delta: "第二轮" })
    })
  })

  it("stops reconnecting after repeated stream errors", async () => {
    vi.useFakeTimers()
    setHistory([])
    renderHook(() => useConversationMessages("conv_p3", "agent_B"))
    await vi.advanceTimersByTimeAsync(0)
    const initialCalls = subscribeMock.mock.calls.length

    for (let i = 0; i < 6; i++) {
      act(() => {
        streamHandler.onError?.(new Error("down"))
      })
      await vi.advanceTimersByTimeAsync(1_000)
    }
    // 1 initial + up to MAX_CONSECUTIVE_STREAM_ERRORS retries, then it stops.
    expect(subscribeMock.mock.calls.length).toBeLessThanOrEqual(initialCalls + 3)
  })
})

describe("shared conversation pipeline: history semantics", () => {
  it("loads history and exposes loading/error states", async () => {
    setHistory(new Error("boom"))
    const { result } = renderHook(() =>
      useConversationMessages("conv_p3", "agent_B"),
    )

    expect(result.current.isLoading).toBe(true)
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.error?.message).toBe("boom")
  })

  it("keeps the message list sorted by sequence across history entries", async () => {
    setHistory([
      makeMessage({ id: "A", sequence: 2 }),
      makeMessage({ id: "B", sequence: 1 }),
    ])
    const { result } = renderHook(() =>
      useConversationMessages("conv_p3", "agent_B"),
    )
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.messages.map((m) => m.id)).toEqual(["B", "A"])
  })
})

// -- P3: sharing, refcounting, lifecycle ------------------------------------

describe("shared conversation pipeline: lifecycle", () => {
  it("N consumers of the same conversation share ONE query and ONE stream", async () => {
    setHistory([makeMessage()])
    const a = renderHook(() => useConversationMessages("conv_p3", "agent_B"))
    const b = renderHook(() => useConversationMessages("conv_p3", "agent_B"))
    const c = renderHook(() => useConversationMessages("conv_p3", "agent_B"))

    await waitFor(() => expect(a.result.current.isLoading).toBe(false))
    await waitFor(() => expect(b.result.current.isLoading).toBe(false))
    await waitFor(() => expect(c.result.current.isLoading).toBe(false))

    expect(queryMock).toHaveBeenCalledTimes(1)
    expect(subscribeMock).toHaveBeenCalledTimes(1)

    act(() => {
      streamHandler.onData?.({ type: "text", delta: "实时" })
    })
    await waitFor(() => {
      expect(a.result.current.messages.some((m) => m.id === "__streaming_preview__")).toBe(true)
    })
    expect(b.result.current.messages.some((m) => m.id === "__streaming_preview__")).toBe(true)
    expect(c.result.current.messages.some((m) => m.id === "__streaming_preview__")).toBe(true)
  })

  it("different conversations get independent pipelines", async () => {
    setHistory([makeMessage()])
    renderHook(() => useConversationMessages("conv_a", "agent_B"))
    renderHook(() => useConversationMessages("conv_b", "agent_B"))

    await waitFor(() => expect(queryMock).toHaveBeenCalledTimes(2))
    expect(subscribeMock).toHaveBeenCalledTimes(2)
  })

  it("closes the stream after the last consumer leaves (grace period)", async () => {
    vi.useFakeTimers()
    setHistory([makeMessage()])
    const { unmount } = renderHook(() => useConversationMessages("conv_p3", "agent_B"))
    await vi.advanceTimersByTimeAsync(0)
    expect(subscribeMock).toHaveBeenCalledTimes(1)

    unmount()
    expect(unsubscribeFn).not.toHaveBeenCalled() // still within grace

    await vi.advanceTimersByTimeAsync(6_000)
    expect(unsubscribeFn).toHaveBeenCalledTimes(1) // torn down
  })

  it("resubscribing within the grace period reuses the warm pipeline (no refetch)", async () => {
    vi.useFakeTimers()
    setHistory([makeMessage()])
    const first = renderHook(() => useConversationMessages("conv_p3", "agent_B"))
    await vi.advanceTimersByTimeAsync(0)
    expect(queryMock).toHaveBeenCalledTimes(1)

    first.unmount()
    const second = renderHook(() => useConversationMessages("conv_p3", "agent_B"))
    await vi.advanceTimersByTimeAsync(0)

    expect(queryMock).toHaveBeenCalledTimes(1)
    expect(second.result.current.messages).toHaveLength(1)
    expect(second.result.current.isLoading).toBe(false)
  })

  it("does not open a stream when no agentId is provided (history only)", async () => {
    setHistory([makeMessage()])
    renderHook(() => useConversationMessages("conv_p3"))

    await waitFor(() => expect(queryMock).toHaveBeenCalledTimes(1))
    expect(subscribeMock).not.toHaveBeenCalled()
  })
})
