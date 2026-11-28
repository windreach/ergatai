import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { useMessageSending } from "@/features/agents/hooks/use-message-sending"
import type { AgentQueueItem, QueuedFile } from "@/features/agents/lib/queue-utils"
import type { Message, MessagePart } from "@/features/agents/stores/message-store"

vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({}),
  },
  trpcClient: {},
}))

vi.mock("@/contexts/TRPCProvider", () => ({
  getQueryClient: () => null,
}))

vi.mock("@/features/agents/stores/conversation-store", () => ({
  useAgentConversationStore: {
    getState: () => ({
      updateConversationTimestamp: vi.fn(),
    }),
  },
}))

vi.mock("@/features/agents/utils/stream-utils", () => ({
  waitForStreamingReady: vi.fn(async () => undefined),
}))

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
  },
}))

const file: QueuedFile = {
  id: "file-1",
  url: "blob:file-1",
  filename: "example.txt",
  mediaType: "text/plain",
  size: 4,
  base64Data: "YWJj",
  isLoading: false,
}

type SendingOptions = Parameters<typeof useMessageSending>[0]

function setup(isStreaming = false) {
  const editor = {
    getValue: vi.fn(() => ""),
    clear: vi.fn(),
    setValue: vi.fn(),
  }
  const service = {
    send: vi.fn(async () => undefined),
    enqueue: vi.fn(async () => undefined),
    sendQueuedItem: vi.fn(async () => undefined),
  }
  const options: SendingOptions = {
    conversation: {
      id: "conv_503994318188_000_0000",
      parentChatId: null,
      mode: "agent",
      isArchived: false,
    },
    workspace: {
      sandboxSetupStatus: "ready",
      isGroupMode: false,
      teamId: null,
      projectPath: "/tmp/project",
      workspaceId: null,
      provider: "local",
    },
    collaboration: {
      session: null,
      enabled: false,
      groupAgents: [],
    },
    inputRefs: {
      editor: { current: editor },
      images: { current: [] },
      files: { current: [file] },
      textContexts: { current: [] },
      diffTextContexts: { current: [] },
      pastedTexts: { current: [] },
      fileContents: { current: new Map() },
      isStreaming: { current: isStreaming },
    },
    actions: {
      scrollToBottom: vi.fn(),
      clearAll: vi.fn(),
      clearTextContexts: vi.fn(),
      clearDiffTextContexts: vi.fn(),
      clearPastedTexts: vi.fn(),
      clearFileContents: vi.fn(),
      clearConversationDraft: vi.fn(),
    },
    queue: {
      addToQueue: vi.fn(),
      popItemFromQueue: vi.fn(),
      removeFromQueue: vi.fn(),
    },
    messaging: {
      handleStop: vi.fn(async () => undefined),
      sendMessageRef: { current: vi.fn(async () => undefined) },
      setMessages: vi.fn(),
      setExpiredQuestionsMap: vi.fn(),
      setGroupAgentRuntimeStatuses: vi.fn(),
      trackMessageSent: vi.fn(),
      submitImplicitInteraction: vi.fn(),
    },
    service,
  }

  const hook = renderHook(() => useMessageSending(options))
  return { ...hook, service, editor }
}

describe("useMessageSending file-only messages", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("sends a file-only message through the normal send path", async () => {
    const { result, service } = setup()

    await act(async () => {
      await result.current.handleSend()
    })

    expect(service.send).toHaveBeenCalledTimes(1)
    expect(service.send).toHaveBeenCalledWith([
      {
        type: "data-file",
        data: {
          url: file.url,
          mediaType: file.mediaType,
          filename: file.filename,
          size: file.size,
          base64Data: file.base64Data,
        },
      },
    ])
  })

  it("force-sends a file-only message", async () => {
    const { result, service } = setup()

    await act(async () => {
      await result.current.handleForceSend()
    })

    expect(service.send).toHaveBeenCalledTimes(1)
    expect(service.send.mock.calls[0][0]).toEqual([
      expect.objectContaining({
        type: "data-file",
        data: expect.objectContaining({ base64Data: file.base64Data }),
      }),
    ])
  })

  it("queues a file-only message without losing its payload", async () => {
    const { result, service } = setup(true)

    await act(async () => {
      await result.current.handleSend()
    })

    expect(service.send).not.toHaveBeenCalled()
    expect(service.enqueue).toHaveBeenCalledTimes(1)
    expect(service.enqueue.mock.calls[0][0].files).toEqual([file])
  })
})
