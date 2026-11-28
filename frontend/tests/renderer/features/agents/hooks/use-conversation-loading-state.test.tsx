import type { ReactNode } from "react"
import { act, renderHook } from "@testing-library/react"
import { createStore, Provider } from "jotai"
import { describe, expect, it } from "vitest"

import { loadingConversationsAtom } from "@/features/agents/atoms"
import { useConversationLoadingState } from "@/features/agents/hooks/use-conversation-loading-state"

type LoadingStateProps = {
  conversationId: string
  parentChatId: string
  isStreaming: boolean
  isActive?: boolean
}

function setup() {
  const store = createStore()
  const wrapper = ({ children }: { children: ReactNode }) => (
    <Provider store={store}>{children}</Provider>
  )

  const hook = renderHook(
    (props: LoadingStateProps) => useConversationLoadingState(props),
    {
      wrapper,
      initialProps: {
        conversationId: "conversation-a",
        parentChatId: "chat-a",
        isStreaming: true,
      },
    },
  )

  return { store, ...hook }
}

describe("useConversationLoadingState", () => {
  it("publishes loading state for the conversation's parent chat", () => {
    const { store } = setup()

    expect(store.get(loadingConversationsAtom).get("conversation-a")).toBe("chat-a")
  })

  it("keeps background loading state when the chat pane unmounts", () => {
    const { store, unmount } = setup()

    unmount()

    expect(store.get(loadingConversationsAtom).get("conversation-a")).toBe("chat-a")
  })

  it("clears loading when the conversation reaches a terminal state", () => {
    const { store, rerender } = setup()

    act(() => {
      rerender({
        conversationId: "conversation-a",
        parentChatId: "chat-a",
        isStreaming: false,
      })
    })

    expect(store.get(loadingConversationsAtom).has("conversation-a")).toBe(false)
  })

  it("does not clear another streaming conversation when the hook changes target", () => {
    const { store, rerender } = setup()

    act(() => {
      rerender({
        conversationId: "conversation-b",
        parentChatId: "chat-b",
        isStreaming: false,
      })
    })

    expect(store.get(loadingConversationsAtom).get("conversation-a")).toBe("chat-a")
    expect(store.get(loadingConversationsAtom).has("conversation-b")).toBe(false)
  })

  it("does not clear loading from an inactive pane", () => {
    const { store, rerender } = setup()

    act(() => {
      rerender({
        conversationId: "conversation-a",
        parentChatId: "chat-a",
        isStreaming: false,
        isActive: false,
      })
    })

    expect(store.get(loadingConversationsAtom).get("conversation-a")).toBe("chat-a")
  })
})
