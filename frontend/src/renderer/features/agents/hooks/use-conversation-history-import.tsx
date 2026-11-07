import { useState } from "react"
import { trpc } from "../../../lib/trpc"

type ConversationHistoryImportOptions = {
  conversationId: string
  agentId?: string | null
  containerRef?: any
}

// History is imported in full on the backend (per session). The frontend no
// longer paginates by scrolling; selecting a session triggers a one-shot
// synchronous full import so its messages are available immediately.
export function useConversationHistoryImport({
  conversationId,
  agentId,
}: ConversationHistoryImportOptions) {
  const utils = trpc.useUtils()
  const importMutation = trpc.ergatai.importConversationHistory.useMutation()
  const [isImporting, setIsImporting] = useState(false)

  const importSync = async (sessionId?: string) => {
    if (!agentId || !conversationId) return
    const acpSessionId = sessionId
    if (!acpSessionId) return
    setIsImporting(true)
    try {
      // Note: Backend caps import at 500 messages per session. Sessions with
      // more than 500 messages will be truncated without further pagination.
      const IMPORT_LIMIT = 500
      await importMutation.mutateAsync({
        conversationId,
        agentId,
        acpSessionId,
        limit: IMPORT_LIMIT,
        sync: true,
      })
      await utils.ergatai.getConversationImportState.invalidate({ conversationId })
      await utils.ergatai.listConversationMessages.invalidate({ conversationId })

      // Check if we hit the limit and warn the user
      const importState = await utils.ergatai.getConversationImportState.fetch({ conversationId })
      if (importState?.total_captured && importState.total_captured > IMPORT_LIMIT) {
        console.warn(
          `[History Import] Session has ${importState.total_captured} messages but only ${IMPORT_LIMIT} were imported. ` +
          `Older messages will not be available.`,
        )
      }
    } catch {
      // Best-effort; backend migration may already have imported it.
    } finally {
      setIsImporting(false)
    }
  }

  return {
    importState: null,
    isImporting,
    importBanner: null as any,
    importSync,
    prewarm: () => {},
  }
}
