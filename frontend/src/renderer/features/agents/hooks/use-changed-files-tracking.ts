import { useAtomValue, useSetAtom } from "jotai"
import { useCallback, useEffect } from "react"
import { conversationFilesAtom, conversationToChatMapAtom, type ConversationFileChange } from "../atoms"
import { trpc } from "../../../lib/trpc"

interface Message {
  role: string
  parts?: unknown[]
}

const EMPTY_FILE_CHANGES: ConversationFileChange[] = []

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
    fileChangesQuery.data ?? conversationFiles.get(conversationId) ?? EMPTY_FILE_CHANGES

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
  }, [chatId, conversationId, setConversationToChatMap])

  const recomputeChangedFiles = useCallback(() => {
    if (!isStreaming) {
      fileChangesQuery.refetch().catch((error) => {
        console.error('[useChangedFilesTracking] Failed to refetch file changes:', error)
      })
    }
  }, [fileChangesQuery, isStreaming])

  useEffect(() => {
    if (!isStreaming && messages.length > 0) {
      // Use setTimeout(…, 0) to defer refetch until after the current render cycle completes.
      // This ensures that any pending message state updates are flushed before we query,
      // avoiding race conditions where we might query stale data.
      const timer = window.setTimeout(() => {
        fileChangesQuery.refetch().catch((error) => {
          console.error('[useChangedFilesTracking] Failed to refetch file changes after message update:', error)
        })
      }, 0)
      return () => window.clearTimeout(timer)
    }
  }, [fileChangesQuery, isStreaming, messages.length])

  return {
    changedFiles,
    recomputeChangedFiles,
    isError: fileChangesQuery.isError,
    error: fileChangesQuery.error,
  }
}
