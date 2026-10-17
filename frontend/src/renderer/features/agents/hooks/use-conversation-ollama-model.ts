import { useAtom } from "jotai"
import { useMemo } from "react"

import { conversationOllamaModelAtomFamily } from "@/lib/atoms"

export function useConversationOllamaModel(conversationId: string) {
  const conversationOllamaModelAtom = useMemo(
    () => conversationOllamaModelAtomFamily(conversationId),
    [conversationId],
  )

  return useAtom(conversationOllamaModelAtom)
}
