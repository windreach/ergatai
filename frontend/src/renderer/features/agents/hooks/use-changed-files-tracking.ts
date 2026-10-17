import { useAtomValue, useSetAtom } from "jotai"
import { useCallback, useEffect } from "react"
import { conversationFilesAtom, conversationToChatMapAtom, type ConversationFileChange } from "../atoms"
import { trpc } from "../../../lib/trpc"

interface Message {
  role: string
  parts?: unknown[]
}

/**
 * Tracks changed files from backend-persisted Edit/Write tool calls.
 * Streaming state is used to avoid querying intermediate messages that are not
 * persisted until the stream finishes.
 */
export function useChangedFilesTracking(
  messages: Message[],
  conversationId: string,
  isStreaming: boolean = false,
  chatId?: string,
  projectPath?: string,
) {
  const setConversationFiles = useSetAtom(conversationFilesAtom)
  const conversationFiles = useAtomValue(conversationFilesAtom)
  const conversationToChatMap = useAtomValue(conversationToChatMapAtom)
  const setConversationToChatMap = useSetAtom(conversationToChatMapAtom)

  const fileChangesQuery = trpc.ergatai.listConversationFileChanges.useQuery(
    { conversationId },
    {
      enabled: Boolean(conversationId) && !isStreaming,
      staleTime: 0,
      refetchOnMount: "always",
      refetchOnWindowFocus: false,
      retry: false,
    },
  )

  const changedFiles: ConversationFileChange[] =
    fileChangesQuery.data ?? conversationFiles.get(conversationId) ?? []

  useEffect(() => {
    setConversationFiles((previous) => {
      const next = new Map(previous)
      next.set(conversationId, changedFiles)
      return next
    })
  }, [changedFiles, conversationId, setConversationFiles])

  useEffect(() => {
    if (!chatId || conversationToChatMap.get(conversationId) === chatId) return
    setConversationToChatMap((previous) => {
      const next = new Map(previous)
      next.set(conversationId, chatId)
      return next
    })
  }, [chatId, conversationId, conversationToChatMap, setConversationToChatMap])

  const recomputeChangedFiles = useCallback(() => {
    if (!isStreaming) {
      void fileChangesQuery.refetch()
    }
  }, [fileChangesQuery, isStreaming])

  useEffect(() => {
    if (!isStreaming && messages.length > 0) {
      const timer = window.setTimeout(() => {
        void fileChangesQuery.refetch()
      }, 0)
      return () => window.clearTimeout(timer)
    }
  }, [fileChangesQuery, isStreaming, messages.length])

  return { changedFiles, recomputeChangedFiles }
}
