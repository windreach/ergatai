"use client"

import { atom } from "jotai"
import { atomFamily } from "jotai/utils"
import { createContext, useContext } from "react"
import type { CoreAgentOption } from "../lib/agent-contract-api"

interface GroupChatContextValue {
  agents: CoreAgentOption[]
  isGroupChat: boolean
}

const GroupChatContext = createContext<GroupChatContextValue>({
  agents: [],
  isGroupChat: false,
})

export const GroupChatProvider = GroupChatContext.Provider

export type GroupAgentChatRequest = {
  agentId: CoreAgentOption["id"]
  conversationId?: string
  requestId: number
  message?: string  // The actual message content to display in side chat
}

export const groupAgentChatRequestAtomFamily = atomFamily((chatId: string) =>
  atom<GroupAgentChatRequest | null>(null),
)

export function useGroupChat() {
  return useContext(GroupChatContext)
}
