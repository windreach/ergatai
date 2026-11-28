import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/contexts/WindowContext", () => ({
  getWindowId: () => "main",
}))

vi.mock("@/features/agents/ui/agent-task-tools", () => ({
  clearTaskSnapshotCache: vi.fn(),
}))

vi.mock("@/features/agents/stores/conversation-runtime-cleanup", () => ({
  clearConversationRuntimeCaches: vi.fn(),
}))

import { loadingConversationsAtom } from "@/features/agents/atoms"
import { useAgentConversationStore } from "@/features/agents/stores/conversation-store"
import { appStore } from "@/lib/jotai-store"

describe("conversation-store loading cleanup", () => {
  beforeEach(() => {
    useAgentConversationStore.setState({
      chatId: "chat-a",
      activeConversationId: "conversation-a",
      openConversationIds: ["conversation-a", "conversation-b"],
      pinnedConversationIds: [],
      allConversations: [],
      splitPaneIds: [],
      splitRatios: [],
    })
    appStore.set(
      loadingConversationsAtom,
      new Map([
        ["conversation-a", "chat-a"],
        ["conversation-b", "chat-a"],
      ]),
    )
  })

  it("clears the closed conversation without affecting other loading conversations", () => {
    useAgentConversationStore.getState().removeFromOpenConversations("conversation-a")

    expect(appStore.get(loadingConversationsAtom).has("conversation-a")).toBe(false)
    expect(appStore.get(loadingConversationsAtom).get("conversation-b")).toBe("chat-a")
  })
})
