/**
 * useAvailableModels — Shared hook for fetching available models
 *
 * Data flow:
 *   1. When a message is sent, fetchAgentModels() retrieves model info from agent's config options via ACP.
 *   2. fetchAgentModels updates ergataiAgentModelInfoAtom via appStore.
 *   3. This hook reads from the atom → UI updates immediately.
 *
 * Fallback: if atom is empty (no messages sent yet), reads from the cached snapshot.
 */

import { useAtomValue } from "jotai"
import { appStore } from "../../../lib/jotai-store"
import { useEffect, useMemo } from "react"
import { showOfflineModeFeaturesAtom } from "../../../lib/atoms"
import { trpc, trpcClient } from "../../../lib/trpc"
import { ergataiAgentModelInfoAtom } from "../lib/ergatai-agent-manager"
import { CLAUDE_MODELS } from "../lib/models"

// ── Types ──

interface ModelItem {
  id: string
  name: string
  version: string
}

interface UseAvailableModelsReturn {
  models: typeof CLAUDE_MODELS
  currentModelId: string | null
  ollamaModels: string[]
  recommendedModel: string | undefined
  isOffline: boolean
  hasOllama: boolean
  isCached: boolean
  isStale: boolean
}

// ── Helper ──

/**
 * Map backend model name to UI format.
 * Uses the normalized name (without context window suffix) as the ID for deduplication.
 */
function mapBackendModelToUI(modelName: string): ModelItem | null {
  const raw = modelName.trim()
  if (!raw || raw.toLowerCase() === "default") return null

  let normalized = raw
    .replace(/^models\//, "")
    .replace(/^claude-/i, "")
    .replace(/-\d{8,}$/i, "")
    .replace(/\[\d+m\]$/, "")

  const id = normalized.toLowerCase()
  let displayName = normalized
    .split(/[-_\s]/)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(" ")

  return { id, name: displayName, version: "" }
}

function normalizeModelId(modelName: string): string {
  return modelName
    .replace(/^models\//, "")
    .replace(/^claude-/i, "")
    .replace(/-\d{8,}$/i, "")
    .replace(/\[\d+m\]$/, "")
    .toLowerCase()
}

// ── Hook ──

export function useAvailableModels(): UseAvailableModelsReturn {
  const showOfflineFeatures = useAtomValue(showOfflineModeFeaturesAtom)

  // PRIMARY source: read from Jotai atom (updated by fetchAgentModels in chat transport)
  const agentModelInfo = useAtomValue(ergataiAgentModelInfoAtom)

  // Derive models from atom — pick the most recently updated entry
  const atomModels = useMemo(() => {
    const entries = Object.values(agentModelInfo)
    if (entries.length === 0) return null

    // Use the most recently fetched agent's models
    const latest = entries.reduce((a, b) => (a.fetchedAt > b.fetchedAt ? a : b))
    if (latest.models.length === 0) return null

    const mapped = latest.models
      .map(mapBackendModelToUI)
      .filter((m): m is NonNullable<typeof m> => m !== null)

    // Deduplicate by id
    const seen = new Set<string>()
    const unique = mapped.filter((m) => {
      if (seen.has(m.id)) return false
      seen.add(m.id)
      return true
    })

    return {
      models: unique,
      current: latest.current ? normalizeModelId(latest.current) : null,
    }
  }, [agentModelInfo])

  // If atom is empty, load from SQLite database into atom (populate cache)
  useEffect(() => {
    if (atomModels) return

    // Read from SQLite database (source of truth) and populate Jotai atom (cache)
    trpcClient.ergatai.getLatestCachedModels.query().then((result) => {
      if (result.models.length > 0) {
        const store = appStore
        const current = store.get(ergataiAgentModelInfoAtom)
        store.set(ergataiAgentModelInfoAtom, {
          ...current,
          _fromDb: {
            models: result.models,
            current: result.current,
            fetchedAt: Date.now(),
          },
        })
      }
      // Database empty — models will be fetched when user sends first message.
      // fetchAgentModels will write to SQLite, then we can read from DB.
      // We intentionally do NOT fetch here without an agentId, as the
      // backend requires a real one and would return 404 otherwise.
    }).catch(() => {})
  }, [atomModels])

  // Use atom-derived models, fall back to hardcoded
  const baseModels = atomModels && atomModels.models.length > 0
    ? atomModels.models
    : CLAUDE_MODELS
  const currentModelId = atomModels?.current ?? null

  // Ollama status
  const { data: ollamaStatus } = trpc.ollama.getStatus.useQuery(undefined, {
    refetchInterval: showOfflineFeatures ? 30000 : false,
    enabled: showOfflineFeatures,
  })

  const isOffline = ollamaStatus ? !ollamaStatus.internet.online : false
  const hasOllama =
    ollamaStatus?.ollama.available && (ollamaStatus?.ollama.models?.length ?? 0) > 0
  const ollamaModels = ollamaStatus?.ollama.models || []
  const recommendedModel = ollamaStatus?.ollama.recommendedModel

  if (showOfflineFeatures && hasOllama && isOffline) {
    return {
      models: baseModels,
      currentModelId,
      ollamaModels,
      recommendedModel,
      isOffline,
      hasOllama: true,
      isCached: false,
      isStale: false,
    }
  }

  return {
    models: baseModels,
    currentModelId,
    ollamaModels: [] as string[],
    recommendedModel: undefined as string | undefined,
    isOffline,
    hasOllama: false,
    isCached: false,
    isStale: false,
  }
}
