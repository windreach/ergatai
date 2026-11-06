import { useEffect, useRef, useState } from "react"
import type { RefObject } from "react"
import { trpc } from "../../../lib/trpc"
import { reloadConversationHistory } from "./use-conversation-messages"

type ConversationHistoryImportOptions = {
  conversationId: string
  agentId?: string | null
  containerRef?: RefObject<HTMLElement | null> | null
}

export function useConversationHistoryImport({
  conversationId,
  agentId,
  containerRef,
}: ConversationHistoryImportOptions) {
  const utils = trpc.useUtils()
  const importStateQuery = trpc.ergatai.getConversationImportState.useQuery(
    { conversationId },
    { enabled: !!conversationId },
  )
  const importMutation = trpc.ergatai.importConversationHistory.useMutation()
  const [isImporting, setIsImporting] = useState(false)
  const lastEnqueuedCursorRef = useRef<string | null>(null)
  const pollingRef = useRef(false)

  const ensureEnqueued = async (
    state: NonNullable<typeof importStateQuery.data>,
  ) => {
    if (!state.has_more || !state.acp_session_id || !agentId) return false
    if (lastEnqueuedCursorRef.current === state.import_cursor) return true
    try {
      await importMutation.mutateAsync({
        conversationId,
        agentId,
        acpSessionId: state.acp_session_id,
        limit: 20,
        cursor: state.import_cursor ?? undefined,
      })
      lastEnqueuedCursorRef.current = state.import_cursor
      return true
    } catch {
      return false
    }
  }

  const importSync = async (sessionId?: string, cursor?: string | null) => {
    if (!agentId || pollingRef.current) return
    const state = importStateQuery.data
    const acpSessionId = sessionId ?? state?.acp_session_id
    if (!state || !state.resume_supported || !state.has_more || !acpSessionId) return

    pollingRef.current = true
    setIsImporting(true)
    const container = containerRef?.current ?? null
    const savedScrollHeight = container?.scrollHeight ?? 0
    const savedScrollTop = container?.scrollTop ?? 0

    try {
      await importMutation.mutateAsync({
        conversationId,
        agentId,
        acpSessionId,
        limit: 20,
        cursor: cursor ?? state.import_cursor ?? undefined,
        sync: true,
      })
      await utils.ergatai.getConversationImportState.invalidate({ conversationId })
    } catch {
      await ensureEnqueued(state)
    }

    reloadConversationHistory(conversationId)

    if (container) {
      setTimeout(() => {
        const newScrollHeight = container.scrollHeight
        container.scrollTop = savedScrollTop + (newScrollHeight - savedScrollHeight)
        setIsImporting(false)
        pollingRef.current = false
      }, 300)
    } else {
      setIsImporting(false)
      pollingRef.current = false
    }
  }

  useEffect(() => {
    const container = containerRef?.current
    if (!container) return

    const onScroll = () => {
      const state = importStateQuery.data
      if (!state || !state.resume_supported || !state.has_more || !state.acp_session_id || !agentId) return

      if (container.scrollTop <= 300 && container.scrollTop > 40) {
        void ensureEnqueued(state)
        return
      }

      if (container.scrollTop <= 40) {
        void importSync()
      }
    }

    container.addEventListener("scroll", onScroll, { passive: true })
    return () => container.removeEventListener("scroll", onScroll)
  }, [containerRef, importStateQuery.data, conversationId, agentId])

  const importBanner =
    !importStateQuery.data?.resume_supported ? (
      <div className="px-3 py-2 text-xs text-muted-foreground text-center">
        该 Agent 不支持历史导入{importStateQuery.data?.last_error ? `：${importStateQuery.data.last_error}` : ""}
      </div>
    ) : isImporting || importMutation.isPending ? (
      <div className="px-3 py-2 text-xs text-muted-foreground text-center">
        正在导入历史消息…
      </div>
    ) : importStateQuery.data?.has_more ? (
      <div className="px-3 py-2 text-xs text-muted-foreground text-center">
        滚动到顶部加载更早消息
      </div>
    ) : importStateQuery.data && importStateQuery.data.imported_count >= 50 ? (
      <div className="px-3 py-2 text-xs text-muted-foreground text-center">
        已导入前 50 条
      </div>
    ) : null

  return {
    importState: importStateQuery.data,
    isImporting,
    importBanner,
    importSync,
    prewarm: (state?: typeof importStateQuery.data) => {
      if (state) void ensureEnqueued(state)
    },
  }
}