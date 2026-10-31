/**
 * useAvailableModels — Shared hook for fetching available models
 *
 * Data flow:
 *   1. Query backend for cached models by profile name (from active agent).
 *   2. Falls back to hardcoded CLAUDE_MODELS if cache is empty.
 *   3. Can trigger refresh via refreshAgentProfileModels mutation.
 *
 * Migration note: This replaces the old Jotai atom-based approach that keyed
 * models by ephemeral agent ID. Now uses profile name (stable, user-facing).
 */

import { useAtomValue } from "jotai"
import { useEffect, useMemo, useRef } from "react"
import { showOfflineModeFeaturesAtom } from "../../../lib/atoms"
import { trpc } from "../../../lib/trpc"
import { ergataiActiveAgentIdAtom } from "../lib/ergatai-agent-manager"
import { CLAUDE_MODELS } from "../lib/models"

// ── Constants ──

const OLLAMA_STATUS_POLL_INTERVAL_MS = 30_000

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
}

// ── Helper ──

/**
 * Normalize a model name to a stable lowercase ID.
 * Strips common prefixes (models/, claude-), date suffixes, and context window tags.
 */
function normalizeModelId(modelName: string): string {
  return modelName
    .replace(/^models\//, "")
    .replace(/^claude-/i, "")
    .replace(/-\d{8,}$/i, "")
    .replace(/\[\d+m\]$/, "")
    .toLowerCase()
}

/**
 * Map backend model name to UI format.
 * Uses the normalized name (without context window suffix) as the ID for deduplication.
 */
function mapBackendModelToUI(modelName: string): ModelItem | null {
  const raw = modelName.trim()
  if (!raw || raw.toLowerCase() === "default") return null

  const id = normalizeModelId(raw)
  if (!id) return null

  // Build display name from the original input (before normalization)
  const normalized = raw
    .replace(/^models\//, "")
    .replace(/^claude-/i, "")
    .replace(/-\d{8,}$/i, "")
    .replace(/\[\d+m\]$/, "")

  const displayName = normalized
    .split(/[-_\s]/)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(" ")

  return { id, name: displayName, version: "" }
}

// ── Hook ──

export function useAvailableModels(agentId?: string | null): UseAvailableModelsReturn {
  const showOfflineFeatures = useAtomValue(showOfflineModeFeaturesAtom)
  const globalAgentId = useAtomValue(ergataiActiveAgentIdAtom)

  // Prefer passed agentId, fall back to global atom
  const effectiveAgentId = agentId ?? globalAgentId

  // Query active agent to get profile name
  const { data: agents } = trpc.ergatai.listAgents.useQuery(undefined, {
    enabled: !!effectiveAgentId,
    refetchOnWindowFocus: false,
  })

  const activeAgent = useMemo(() => {
    if (!effectiveAgentId || !agents) return null
    return agents.find((a) => a.agent_id === effectiveAgentId) ?? null
  }, [effectiveAgentId, agents])

  // The profile registry is the only authoritative model-cache key. Static
  // model lists remain a UI fallback when no runtime agent has been resolved.
  const profileName = activeAgent?.profile ?? null

  // Query cached models from backend by profile name
  const { data: modelData, refetch, isLoading } = trpc.ergatai.getAgentProfileModels.useQuery(
    { profileName: profileName ?? "" },
    { enabled: !!profileName, refetchOnWindowFocus: false },
  )

  // Debug logging: only log when key values change (not on every render)
  useEffect(() => {
    console.log("[useAvailableModels] State:", {
      agentId,
      globalAgentId,
      effectiveAgentId,
      profileName,
      modelCount: modelData?.models?.length ?? 0,
    })
  }, [agentId, globalAgentId, effectiveAgentId, profileName, modelData?.models?.length])

  const refreshMutation = trpc.ergatai.refreshAgentProfileModels.useMutation({
    onSuccess: (data) => {
      console.log("[useAvailableModels] Refresh success:", { profileName, modelsCount: data.models?.length ?? 0 })
      refetch()
    },
    onError: (error) => {
      console.error("[useAvailableModels] Refresh failed:", { profileName, error: error.message })
    },
  })

  // Refresh cache misses from an effect, never during render. Keep one request
  // per profile so a failed lookup cannot create a mutation loop.
  const requestedModelProfileRef = useRef<string | null>(null)
  const refreshMutationRef = useRef(refreshMutation)
  refreshMutationRef.current = refreshMutation

  useEffect(() => {
    if (!modelData || !profileName) {
      console.log("[useAvailableModels] Refresh skipped:", { hasModelData: !!modelData, profileName })
      return
    }
    if (modelData.models.length > 0) return
    if (requestedModelProfileRef.current === profileName) return

    console.log("[useAvailableModels] Triggering refresh for profile:", profileName)
    requestedModelProfileRef.current = profileName
    refreshMutationRef.current.mutate({ profileName })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refreshMutation is unstable, use ref
  }, [modelData, profileName])

  // Map backend response to UI format
  const backendModels = useMemo(() => {
    if (!modelData || modelData.models.length === 0) return null

    const mapped = modelData.models
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
      current: modelData.current ? normalizeModelId(modelData.current) : null,
    }
  }, [modelData])

  // Use backend models, fall back to hardcoded
  const baseModels = backendModels && backendModels.models.length > 0
    ? backendModels.models
    : CLAUDE_MODELS
  const currentModelId = backendModels?.current ?? null

  // Ollama status
  const { data: ollamaStatus } = trpc.ollama.getStatus.useQuery(undefined, {
    refetchInterval: showOfflineFeatures ? OLLAMA_STATUS_POLL_INTERVAL_MS : false,
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
    }
  }

  return {
    models: baseModels,
    currentModelId,
    ollamaModels,
    recommendedModel,
    isOffline,
    hasOllama: false,
  }
}
