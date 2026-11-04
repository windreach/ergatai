import { describe, expect, it, vi, beforeEach } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"
import { atom } from "jotai"

const { stableBindings, stableAtom } = vi.hoisted(() => {
  const { atom } = require("jotai")
  return {
    stableBindings: {
      data: [
        { agentId: "agent_a", agentName: "Agent A", conversationId: "conv_a" },
      ],
      isLoading: false,
      isError: false,
    },
    stableAtom: atom(null),
  }
})

vi.mock("../../../../../src/renderer/lib/trpc", () => ({
  trpc: {
    ergatai: {
      getAgentBindings: {
        useQuery: vi.fn(() => stableBindings),
      },
    },
  },
}))

vi.mock("../../../../../src/renderer/features/agents", () => ({
  groupAgentChatRequestAtomFamily: () => stableAtom,
}))

vi.mock("../../../../../src/renderer/features/agents/public", () => ({
  agentContractApi: {
    listCoreAgents: vi.fn().mockResolvedValue([
      { id: "agent_a", name: "Agent A", defaultCommand: "agent_a" },
    ]),
  },
  CORE_AGENT_OPTIONS: [{ id: "agent_a", name: "Agent A", defaultCommand: "agent_a" }],
}))

vi.mock("../../../../../src/renderer/features/details-sidebar/lib/chat-contract-api", () => ({
  chatContractApi: {
    createConversation: vi.fn(async (agent: any, backendConversationId: string) => ({
      id: backendConversationId,
      backendConversationId,
      agent: { ...agent },
      messages: [],
    })),
  },
}))

import { useSideChatController } from "../../../../../src/renderer/features/details-sidebar/hooks/use-side-chat-controller"

describe("useSideChatController", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("opens a side chat for a bound agent", async () => {
    const { result } = renderHook(() => useSideChatController("chat_1", true))

    await waitFor(() => expect(result.current.chatAgentsLoaded).toBe(true))

    await act(async () => {
      await result.current.processAgentRequest(result.current.allAgentsRef.current[0])
    })

    expect(result.current.sideChats).toHaveLength(1)
    expect(result.current.sideChats[0].backendConversationId).toBe("conv_a")
    expect(result.current.activeSideChatId).toBe("conv_a")
  })

  it("does not create duplicate side chats for the same agent", async () => {
    const { result } = renderHook(() => useSideChatController("chat_1", true))

    await waitFor(() => expect(result.current.chatAgentsLoaded).toBe(true))

    const agent = result.current.allAgentsRef.current[0]

    await act(async () => {
      await Promise.all([
        result.current.processAgentRequest(agent),
        result.current.processAgentRequest(agent),
      ])
    })

    expect(result.current.sideChats).toHaveLength(1)
  })

  it("focuses an already open side chat instead of recreating it", async () => {
    const { result } = renderHook(() => useSideChatController("chat_1", true))

    await waitFor(() => expect(result.current.chatAgentsLoaded).toBe(true))

    const agent = result.current.allAgentsRef.current[0]

    await act(async () => {
      await result.current.processAgentRequest(agent)
    })

    await act(async () => {
      await result.current.processAgentRequest(agent)
    })

    expect(result.current.sideChats).toHaveLength(1)
    expect(result.current.activeSideChatId).toBe("conv_a")
  })
})