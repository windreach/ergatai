import { describe, expect, it, vi, beforeEach } from "vitest"
import { renderHook, waitFor, act } from "@testing-library/react"

// Mock tRPC module – must be declared before importing the hook.
//
// The brief calls for vi.mock; we use vitest's vi.mock which provides
// equivalent functionality. The mock exposes the two endpoints the hook is
// expected to consume: listConversationMessages (query) and
// subscribeConversationMessages (subscription – will be wired up in task 2).
vi.mock("../../../../../src/renderer/lib/trpc", () => ({
  trpc: {
    ergatai: {
      listConversationMessages: {
        useQuery: vi.fn(),
      },
      subscribeConversationMessages: {
        useSubscription: vi.fn(),
      },
    },
  },
  trpcClient: {},
}))

// Import the hook and trpc after the mock is registered
import { useConversationMessages } from "../../../../../src/renderer/features/agents/hooks/use-conversation-messages"
import { trpc } from "../../../../../src/renderer/lib/trpc"

describe("useConversationMessages", () => {
  beforeEach(() => {
    vi.clearAllMocks()

    // Default: query still loading
    vi.mocked(trpc.ergatai.listConversationMessages.useQuery).mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
    } as any)

    vi.mocked(trpc.ergatai.subscribeConversationMessages.useSubscription).mockReturnValue({
      error: null,
    } as any)
  })

  it("should load historical messages on mount", async () => {
    const mockMessages = [
      {
        id: "1",
        conversationId: "conv-123",
        sequence: 1,
        role: "user",
        parts: [],
        metadata: null,
        createdAt: new Date("2024-01-01"),
      },
      {
        id: "2",
        conversationId: "conv-123",
        sequence: 2,
        role: "assistant",
        parts: [],
        metadata: null,
        createdAt: new Date("2024-01-01"),
      },
    ]

    vi.mocked(trpc.ergatai.listConversationMessages.useQuery).mockImplementation(
      (input, options) => {
        setTimeout(() => (options as any).onSuccess?.(mockMessages), 0)
        return { data: mockMessages, isLoading: false, error: null } as any
      }
    )

    vi.mocked(trpc.ergatai.subscribeConversationMessages.useSubscription).mockReturnValue({
      error: null,
    } as any)

    const { result } = renderHook(() => useConversationMessages("conv-123"))

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(result.current.messages).toEqual(mockMessages)
  })

  it("should return initial loading state before data arrives", () => {
    vi.mocked(trpc.ergatai.listConversationMessages.useQuery).mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
    } as any)

    const { result } = renderHook(() => useConversationMessages("conv-456"))

    expect(result.current.isLoading).toBe(true)
    expect(result.current.messages).toEqual([])
    expect(result.current.error).toBeNull()
  })

  it("should expose errors from the query", async () => {
    const queryError = new Error("Network error")

    vi.mocked(trpc.ergatai.listConversationMessages.useQuery).mockImplementation(
      (input, options) => {
        setTimeout(() => (options as any).onError?.(queryError), 0)
        return { data: undefined, isLoading: false, error: queryError } as any
      }
    )

    const { result } = renderHook(() => useConversationMessages("conv-789"))

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(result.current.error).toBe(queryError)
    expect(result.current.messages).toEqual([])
  })

  it("should update messages when data changes", async () => {
    const mockMessages = [
      {
        id: "1",
        conversationId: "conv-123",
        sequence: 1,
        role: "user",
        parts: [],
        metadata: null,
        createdAt: new Date("2024-01-01"),
      },
    ]

    // Start with loading state
    vi.mocked(trpc.ergatai.listConversationMessages.useQuery).mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
    } as any)

    const { result, rerender } = renderHook(() => useConversationMessages("conv-123"))

    // Initial state: loading
    expect(result.current.isLoading).toBe(true)
    expect(result.current.messages).toEqual([])

    // Simulate data loaded by changing mock and rerendering
    vi.mocked(trpc.ergatai.listConversationMessages.useQuery).mockReturnValue({
      data: mockMessages,
      isLoading: false,
      error: null,
    } as any)

    rerender()

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
      expect(result.current.messages).toEqual(mockMessages)
    })
  })

  it("should receive new messages via subscription", async () => {
    const historicalMessages = [
      {
        id: "1",
        conversationId: "conv-123",
        sequence: 1,
        role: "user",
        parts: [],
        metadata: null,
        createdAt: new Date("2024-01-01"),
      },
    ]
    const newMessage = {
      id: "2",
      conversationId: "conv-123",
      sequence: 2,
      role: "assistant",
      parts: [],
      metadata: null,
      createdAt: new Date("2024-01-01"),
    }

    let subscriptionCallback: ((msg: Message) => void) | null = null

    vi.mocked(trpc.ergatai.listConversationMessages.useQuery).mockImplementation(
      (input, options) => {
        setTimeout(() => (options as any).onSuccess?.(historicalMessages), 0)
        return { data: historicalMessages, isLoading: false, error: null } as any
      }
    )

    vi.mocked(
      trpc.ergatai.subscribeConversationMessages.useSubscription
    ).mockImplementation((input, options) => {
      subscriptionCallback = (options as any).onData
      return { error: null } as any
    })

    const { result } = renderHook(() => useConversationMessages("conv-123"))

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.messages).toHaveLength(1)

    // Wait for subscription to be set up
    await waitFor(() => expect(subscriptionCallback).not.toBeNull())

    // Simulate new message from subscription
    act(() => {
      subscriptionCallback?.(newMessage)
    })

    await waitFor(() => {
      expect(result.current.messages).toHaveLength(2)
      expect(result.current.messages[1].id).toBe("2")
    })
  })

  it("should deduplicate messages", async () => {
    const message = {
      id: "1",
      conversationId: "conv-123",
      sequence: 1,
      role: "user",
      parts: [],
      metadata: null,
      createdAt: new Date("2024-01-01"),
    }
    let subscriptionCallback: ((msg: Message) => void) | null = null

    vi.mocked(trpc.ergatai.listConversationMessages.useQuery).mockImplementation(
      (input, options) => {
        setTimeout(() => (options as any).onSuccess?.([message]), 0)
        return { data: [message], isLoading: false, error: null } as any
      }
    )

    vi.mocked(
      trpc.ergatai.subscribeConversationMessages.useSubscription
    ).mockImplementation((input, options) => {
      subscriptionCallback = (options as any).onData
      return { error: null } as any
    })

    const { result } = renderHook(() => useConversationMessages("conv-123"))
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    // Wait for subscription to be set up
    await waitFor(() => expect(subscriptionCallback).not.toBeNull())

    // Try to add duplicate
    act(() => {
      subscriptionCallback?.(message)
    })
    await waitFor(() => expect(result.current.messages).toHaveLength(1))
  })

  it("should sort messages by sequence", async () => {
    const messages = [
      {
        id: "1",
        conversationId: "conv-123",
        sequence: 1,
        role: "user",
        parts: [],
        metadata: null,
        createdAt: new Date("2024-01-01"),
      },
      {
        id: "3",
        conversationId: "conv-123",
        sequence: 3,
        role: "assistant",
        parts: [],
        metadata: null,
        createdAt: new Date("2024-01-01"),
      },
    ]
    let subscriptionCallback: ((msg: Message) => void) | null = null

    vi.mocked(trpc.ergatai.listConversationMessages.useQuery).mockImplementation(
      (input, options) => {
        setTimeout(() => (options as any).onSuccess?.(messages), 0)
        return { data: messages, isLoading: false, error: null } as any
      }
    )

    vi.mocked(
      trpc.ergatai.subscribeConversationMessages.useSubscription
    ).mockImplementation((input, options) => {
      subscriptionCallback = (options as any).onData
      return { error: null } as any
    })

    const { result } = renderHook(() => useConversationMessages("conv-123"))
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    // Wait for subscription to be set up
    await waitFor(() => expect(subscriptionCallback).not.toBeNull())

    // Add message with sequence 2 (out of order)
    act(() => {
      subscriptionCallback?.({
        id: "2",
        conversationId: "conv-123",
        sequence: 2,
        role: "user",
        parts: [],
        metadata: null,
        createdAt: new Date("2024-01-01"),
      })
    })

    await waitFor(() => {
      expect(result.current.messages).toHaveLength(3)
      expect(result.current.messages.map((m) => m.sequence)).toEqual([1, 2, 3])
    })
  })

  it("should expose subscription errors", async () => {
    const error = new Error("SSE connection failed")

    vi.mocked(trpc.ergatai.listConversationMessages.useQuery).mockReturnValue({
      data: [],
      isLoading: false,
      error: null,
    } as any)

    vi.mocked(
      trpc.ergatai.subscribeConversationMessages.useSubscription
    ).mockReturnValue({
      error,
    } as any)

    const { result } = renderHook(() => useConversationMessages("conv-123"))
    await waitFor(() => expect(result.current.error).toBe(error))
  })
})
