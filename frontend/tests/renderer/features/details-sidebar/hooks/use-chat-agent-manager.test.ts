import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"

const mocks = vi.hoisted(() => ({
  bindings: [] as Array<Record<string, unknown>>,
  refetchResult: [] as Array<Record<string, unknown>>,
  createConversation: vi.fn(),
  spawnAgent: vi.fn(),
  invalidateBindings: vi.fn(),
  toastInfo: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock("../../../../../src/renderer/lib/trpc", () => ({
  trpc: {
    ergatai: {
      getAgentBindings: {
        useQuery: () => ({
          data: mocks.bindings,
          isLoading: false,
          refetch: vi.fn(async () => ({ data: mocks.refetchResult })),
        }),
      },
      spawnAgent: {
        useMutation: () => ({ mutateAsync: mocks.spawnAgent }),
      },
    },
    useUtils: () => ({
      ergatai: {
        getAgentBindings: { invalidate: mocks.invalidateBindings },
      },
    }),
  },
  trpcClient: {
    ergatai: {
      createConversation: { mutate: mocks.createConversation },
    },
  },
}))

vi.mock("sonner", () => ({
  toast: {
    info: mocks.toastInfo,
    error: mocks.toastError,
    success: vi.fn(),
  },
}))

vi.mock("../../../../../src/renderer/features/agents/public", () => ({
  getCoreAgentDisplayName: (value?: string | null) => {
    const key = value?.trim().toLowerCase()
    if (key === "claude" || key === "claude-code") return "Claude Code"
    return undefined
  },
}))

import { useChatAgentManager } from "../../../../../src/renderer/features/details-sidebar/hooks/use-chat-agent-manager"

const claude = {
  id: "claude-code",
  name: "Claude Code",
  profileName: "claude-code",
}

function renderManager(overrides: Partial<Parameters<typeof useChatAgentManager>[0]> = {}) {
  const openAgentChat = vi.fn()
  const view = renderHook(() =>
    useChatAgentManager({
      chatId: "chat_1",
      participants: [],
      coreAgents: [claude],
      canCreateAgent: true,
      openAgentChat,
      ...overrides,
    }),
  )
  return { ...view, openAgentChat }
}

describe("useChatAgentManager", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.bindings.length = 0
    mocks.refetchResult = [
      {
        agentId: "agent_new",
        agentCommand: "claude-code",
        agentName: "claude-code",
        conversationId: "conv_new",
      },
    ]
    mocks.createConversation.mockResolvedValue({ id: "conv_new" })
    mocks.spawnAgent.mockResolvedValue({ agent_id: "agent_new" })
  })

  it("reuses an existing participant instead of spawning a duplicate", async () => {
    const { result, openAgentChat } = renderManager({
      participants: [
        {
          agentId: "agent_existing",
          coreAgentId: "claude-code",
          profile: "claude",
          conversationId: "conv_existing",
        },
      ],
    })

    await act(async () => {
      await result.current.handleSelectAgent(claude)
    })

    expect(openAgentChat).toHaveBeenCalledWith(
      "agent_existing",
      "claude-code",
      "conv_existing",
    )
    expect(mocks.createConversation).not.toHaveBeenCalled()
    expect(mocks.spawnAgent).not.toHaveBeenCalled()
  })

  it("creates only one agent when the same profile is selected twice", async () => {
    let finishSpawn: ((value: { agent_id: string }) => void) | undefined
    mocks.spawnAgent.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishSpawn = resolve
        }),
    )
    const { result, openAgentChat } = renderManager()

    let first: Promise<void>
    await act(async () => {
      first = result.current.handleSelectAgent(claude)
      // The second click happens while the first spawn is still in flight.
      await result.current.handleSelectAgent(claude)
      await waitFor(() => expect(mocks.spawnAgent).toHaveBeenCalledTimes(1))
    })

    expect(mocks.createConversation).toHaveBeenCalledTimes(1)
    expect(mocks.spawnAgent).toHaveBeenCalledTimes(1)
    // The menu entry is hidden locally while the backend list catches up.
    expect(result.current.availableAgents).toHaveLength(0)

    await act(async () => {
      finishSpawn?.({ agent_id: "agent_new" })
      await first
    })

    expect(openAgentChat).toHaveBeenCalledWith(
      "agent_new",
      "claude-code",
      "conv_new",
    )
  })

  it("does not spawn when the profile is already the main chat agent", async () => {
    mocks.bindings.push({
      agentId: "agent_main",
      agentCommand: "claude-code",
      agentName: "claude-code",
      conversationId: "conv_main",
    })
    const { result } = renderManager({ activeConversationId: "conv_main" })

    await act(async () => {
      await result.current.handleSelectAgent(claude)
    })

    expect(mocks.toastInfo).toHaveBeenCalled()
    expect(mocks.createConversation).not.toHaveBeenCalled()
    expect(mocks.spawnAgent).not.toHaveBeenCalled()
  })

  it("does not create agents before a chat exists", async () => {
    const { result } = renderManager({ chatId: "proj_1_2_3", canCreateAgent: false })

    await act(async () => {
      await result.current.handleSelectAgent(claude)
    })

    expect(mocks.toastError).toHaveBeenCalled()
    expect(mocks.createConversation).not.toHaveBeenCalled()
    expect(mocks.spawnAgent).not.toHaveBeenCalled()
  })
})
