import { render, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => {
  const utils = {
    changes: {
      resolveProjectPath: { fetch: vi.fn() },
    },
    worktreeConfig: {
      getByPath: { fetch: vi.fn() },
    },
    ergatai: {
      getChatAgents: { fetch: vi.fn() },
    },
    chats: {
      get: { fetch: vi.fn() },
    },
    client: {
      changes: {
        mergeChatBranch: { mutate: vi.fn() },
      },
    },
  }

  return {
    useQuery: vi.fn(),
    utils,
    isStreaming: vi.fn(() => false),
  }
})

vi.mock("@/lib/trpc", () => ({
  trpc: {
    chats: { list: { useQuery: mocks.useQuery } },
    useUtils: () => mocks.utils,
  },
}))

vi.mock("@/features/agents/stores/streaming-status-store", () => ({
  useStreamingStatusStore: {
    getState: () => ({ isStreaming: mocks.isStreaming }),
  },
}))

vi.mock("@/features/agents/stores/message-queue-store", () => ({
  useMessageQueueStore: {
    getState: () => ({ queues: {} }),
  },
}))

import { AutoMergeManager } from "@/features/agents/components/auto-merge-manager"

function chat(overrides: Record<string, unknown> = {}) {
  return {
    id: "chat_1",
    archivedAt: null,
    branch: "chat-branch",
    baseBranch: "main",
    worktreePath: "/worktrees/chat-1",
    ...overrides,
  }
}

describe("AutoMergeManager", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.useQuery.mockReturnValue({ data: [] })
    mocks.utils.changes.resolveProjectPath.fetch.mockResolvedValue({
      projectPath: "/project",
    })
    mocks.utils.worktreeConfig.getByPath.fetch.mockResolvedValue({
      config: {},
    })
    mocks.utils.ergatai.getChatAgents.fetch.mockResolvedValue({
      all_idle: true,
    })
    mocks.utils.chats.get.fetch.mockResolvedValue({
      conversations: [{ id: "conv_1" }],
    })
    mocks.utils.client.changes.mergeChatBranch.mutate.mockResolvedValue({})
    mocks.isStreaming.mockReturnValue(false)
  })

  it("deduplicates project config reads and skips heavy queries when auto-merge is off", async () => {
    mocks.useQuery.mockReturnValue({
      data: [
        chat({ id: "chat_1", worktreePath: "/worktrees/chat-1" }),
        chat({ id: "chat_2", worktreePath: "/worktrees/chat-2" }),
        chat({ id: "chat_3", worktreePath: "/worktrees/chat-3" }),
      ],
    })

    render(<AutoMergeManager />)

    await waitFor(() => {
      expect(
        mocks.utils.worktreeConfig.getByPath.fetch,
      ).toHaveBeenCalledTimes(1)
    })

    expect(
      mocks.utils.changes.resolveProjectPath.fetch,
    ).toHaveBeenCalledTimes(3)
    expect(mocks.utils.ergatai.getChatAgents.fetch).not.toHaveBeenCalled()
    expect(mocks.utils.chats.get.fetch).not.toHaveBeenCalled()
    expect(
      mocks.utils.client.changes.mergeChatBranch.mutate,
    ).not.toHaveBeenCalled()
  })

  it("only runs the merge pipeline for chats whose project enables auto-merge", async () => {
    mocks.utils.worktreeConfig.getByPath.fetch.mockResolvedValue({
      config: { "auto-merge": true },
    })
    mocks.useQuery.mockReturnValue({
      data: [
        chat({ id: "chat_1", worktreePath: "/worktrees/chat-1" }),
        chat({ id: "chat_2", worktreePath: "/worktrees/chat-2" }),
      ],
    })

    render(<AutoMergeManager />)

    await waitFor(() => {
      expect(
        mocks.utils.client.changes.mergeChatBranch.mutate,
      ).toHaveBeenCalledTimes(2)
    })

    expect(
      mocks.utils.worktreeConfig.getByPath.fetch,
    ).toHaveBeenCalledTimes(1)
    expect(mocks.utils.ergatai.getChatAgents.fetch).toHaveBeenCalledTimes(2)
    expect(mocks.utils.chats.get.fetch).toHaveBeenCalledTimes(2)
  })

  it("ignores archived and incomplete chats", async () => {
    mocks.useQuery.mockReturnValue({
      data: [
        chat({ id: "archived", archivedAt: new Date() }),
        chat({ id: "no-branch", branch: null }),
        chat({ id: "no-base", baseBranch: null }),
        chat({ id: "no-worktree", worktreePath: null }),
      ],
    })

    render(<AutoMergeManager />)

    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(
      mocks.utils.changes.resolveProjectPath.fetch,
    ).not.toHaveBeenCalled()
  })

  it("does not restart the scan when the chat list refreshes", async () => {
    const initial = [
      chat({ id: "chat_1", worktreePath: "/worktrees/chat-1" }),
    ]
    mocks.useQuery.mockReturnValue({ data: initial })

    const { rerender } = render(<AutoMergeManager />)

    await waitFor(() => {
      expect(
        mocks.utils.changes.resolveProjectPath.fetch,
      ).toHaveBeenCalledTimes(1)
    })

    mocks.useQuery.mockReturnValue({
      data: [...initial, chat({ id: "chat_2", worktreePath: "/worktrees/chat-2" })],
    })
    rerender(<AutoMergeManager />)

    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(
      mocks.utils.changes.resolveProjectPath.fetch,
    ).toHaveBeenCalledTimes(1)
  })
})
