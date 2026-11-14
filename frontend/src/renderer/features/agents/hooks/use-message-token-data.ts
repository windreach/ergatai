import { useMemo } from "react"
import type { MessageTokenData } from "../ui/agent-context-indicator"

type TokenMessage = {
  role?: string
  metadata?: unknown
}

type SessionStateLike = {
  contextUsed?: number
  contextWindow?: number
  contextQuota?: {
    inputTokens?: number | null
    outputTokens?: number | null
    totalTokens?: number | null
    cachedInputTokens?: number | null
    cacheWriteInputTokens?: number | null
    reasoningOutputTokens?: number | null
    modelUsage?: unknown
  }
} | null | undefined

/**
 * Shared computation for the ChatInputArea context indicator.
 *
 * Mirrors the main chat's logic so side chats and any other chat surface
 * derive token/cost/context data the same way instead of duplicating the
 * metadata parsing rules.
 */
export function useMessageTokenData(
  messages: TokenMessage[],
  provider: string | undefined,
  sessionState: SessionStateLike,
): MessageTokenData {
  return useMemo(() => {
    const lastAssistantWithTokenData = messages.findLast((msg) => {
      if (msg.role !== "assistant" || !msg.metadata) return false
      const metadata = msg.metadata as {
        inputTokens?: number
        outputTokens?: number
        totalTokens?: number
        cacheReadInputTokens?: number
        cacheCreationInputTokens?: number
        modelContextWindow?: number
      }

      return (
        metadata.inputTokens !== undefined ||
        metadata.outputTokens !== undefined ||
        metadata.totalTokens !== undefined ||
        metadata.cacheReadInputTokens !== undefined ||
        metadata.cacheCreationInputTokens !== undefined ||
        metadata.modelContextWindow !== undefined
      )
    })

    const metadata = lastAssistantWithTokenData?.metadata as
      | {
          inputTokens?: number
          outputTokens?: number
          totalTokens?: number
          totalCostUsd?: number
          cacheReadInputTokens?: number
          cacheCreationInputTokens?: number
          modelContextWindow?: number
        }
      | undefined

    const cacheReadInputTokens = metadata?.cacheReadInputTokens ?? 0
    const cacheCreationInputTokens = metadata?.cacheCreationInputTokens ?? 0
    const codexInputTokensFromTotal =
      metadata?.totalTokens !== undefined
        ? Math.max(0, metadata.totalTokens - (metadata?.outputTokens ?? 0))
        : undefined

    const contextQuota = sessionState?.contextQuota

    // Prefer ACP extension quota detail when the adapter reports it; fall back to
    // message metadata. This keeps token accounting working for adapters that do
    // not populate per-message usage metadata.
    const quotaInputTokens = contextQuota?.inputTokens
    const quotaOutputTokens = contextQuota?.outputTokens
    const quotaTotalTokens = contextQuota?.totalTokens
    const quotaCachedInputTokens = contextQuota?.cachedInputTokens ?? 0
    const quotaCacheWriteInputTokens = contextQuota?.cacheWriteInputTokens ?? 0

    const metadataTotalInputTokens =
      provider === "codex"
        ? (codexInputTokensFromTotal ?? metadata?.inputTokens ?? 0)
        : (metadata?.inputTokens ?? 0) +
          cacheReadInputTokens +
          cacheCreationInputTokens

    const totalInputTokens =
      quotaInputTokens != null
        ? provider === "codex"
          ? (quotaTotalTokens != null
              ? Math.max(0, quotaTotalTokens - (quotaOutputTokens ?? 0))
              : quotaInputTokens)
          : quotaInputTokens + quotaCachedInputTokens + quotaCacheWriteInputTokens
        : metadataTotalInputTokens
    const totalOutputTokens =
      quotaOutputTokens != null ? quotaOutputTokens : (metadata?.outputTokens ?? 0)
    const totalCostUsd = metadata?.totalCostUsd ?? 0
    const contextWindow = metadata?.modelContextWindow

    const messageCount = messages.length

    const contextUsed = sessionState?.contextUsed
    const sessionContextWindow = sessionState?.contextWindow

    return {
      totalInputTokens,
      totalOutputTokens,
      totalCostUsd,
      messageCount,
      contextWindow: sessionContextWindow || contextWindow,
      contextUsed,
      contextQuota: contextQuota ?? undefined,
    }
  }, [messages, provider, sessionState])
}