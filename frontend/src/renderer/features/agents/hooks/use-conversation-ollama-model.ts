import { useAtom } from "jotai"

import { conversationOllamaModelAtomFamily } from "@/lib/atoms"

export function useConversationOllamaModel(conversationId: string) {
  // atomFamily already caches atoms, so direct call is efficient
  // Guard against empty conversationId at runtime
  const atom = conversationId
    ? conversationOllamaModelAtomFamily(conversationId)
    : conversationOllamaModelAtomFamily("")

  return useAtom(atom)
}
