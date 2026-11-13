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
  provider?: string
}

interface UseAvailableModelsReturn {
  models: typeof CLAUDE_MODELS
  currentModelId: string | null
  defaultModelId: string | null
  agentSelectedModelId: string | null
  lastKnownModels: ModelItem[]
  status: "available" | "unsupported" | "not_detected"
  source: "acp_config_options" | "config_file" | "agent_sdk" | "none"
  verifiedAt: number | null
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
function extractModelVersion(text?: string): string {
  if (!text) return ""
  const match = text.match(/\d+(?:\.\d+)+/)
  return match ? match[0] : ""
}

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

function mapBackendModelDetailToUI(detail: {
  id: string
  name?: string
  description?: string
  provider?: string
}): ModelItem | null {
  const raw = detail.id.trim()
  if (!raw || raw.toLowerCase() === "default") return null

  const id = normalizeModelId(raw)
  if (!id) return null

  const displayName =
    (detail.name && detail.name.trim()) ||
    raw
      .replace(/^models\//, "")
      .replace(/^claude-/i, "")
      .replace(/-\d{8,}$/i, "")
      .replace(/\[\d+m\]$/, "")
      .split(/[-_\s]/)
      .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
      .join(" ")

  return {
    id,
    name: displayName,
    version: extractModelVersion(detail.description),
    provider: detail.provider,
  }
}

type RuntimeConfigOption = {
  id?: unknown
  name?: unknown
  category?: unknown
  kind?: unknown
}

function configSelectorIdentity(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/[^a-zA-Z0-9]/g, "").toLowerCase()
    : ""
}

function configOptionCategory(value: unknown): string | null {
  if (typeof value !== "string") return null
  // Backend serializes Rust enum variants with Debug: "Model", or
  // `Other("custom")` for unknown categories.
  const custom = value.match(/Other\("([^"]+)"\)/)
  return (custom?.[1] ?? value).toLowerCase()
}

/**
 * Runtime `current` must come from the active agent, not the profile cache.
 * A profile can have several sessions and users may change models outside
 * Ergatai; this reads the live ACP snapshot already returned with agent info.
 */
export function extractRuntimeModelFromConfigOptions(
  options: unknown,
): string | null {
  if (!Array.isArray(options)) return null

  const candidates = options.filter((option): option is RuntimeConfigOption => {
    if (!option || typeof option !== "object") return false
    const category = configOptionCategory((option as RuntimeConfigOption).category)
    const id = configSelectorIdentity((option as RuntimeConfigOption).id)
    const name = configSelectorIdentity((option as RuntimeConfigOption).name)
    if (category === "mode" || category === "model_config" || category === "thought_level") {
      return false
    }
    return (
      category === "model" ||
      id === "model" ||
      id === "modelselector" ||
      name === "model" ||
      name === "modelselector"
    )
  })

  const modelOption = candidates.find(
    (option) => configOptionCategory(option.category) === "model",
  ) ?? candidates[0]
  if (!modelOption || typeof modelOption.kind !== "object" || modelOption.kind === null) {
    return null
  }

  const kind = modelOption.kind as Record<string, unknown>
  if (kind.type !== "select") return null
  const current = kind.currentValue
  return typeof current === "string" && current.trim() ? current.trim() : null
}

// ── Hook ──

// react-doctor-disable-next-line no-high-complexity-react-function
export function useAvailableModels(agentId?: string | null, profileHint?: string | null): UseAvailableModelsReturn {
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
  // Fall back to a profile hint (e.g. the agent provider name) so models can
  // still be enumerated from config files even before an agent is running.
  const profileName = activeAgent?.profile ?? profileHint ?? null

  // Config-file reads do not require a running agent: as long as we have a
  // resolved profile name, the backend can enumerate models from that profile's
  // config files (SDK/ACP remain fallbacks when those reads are empty).
  const canRefreshModels = !!profileName

  // Query cached models from backend by profile name
  // Synchronously hydrate from a local cache so the selector renders models
  // immediately on chat open, while the network query refreshes in background.
  const placeholderData = useMemo(() => {
    if (!profileName) return undefined
    try {
      const raw = localStorage.getItem(`ergatai:available-models:${profileName}`)
      if (!raw) return undefined
      const parsed = JSON.parse(raw)
      if (parsed && Array.isArray(parsed.models)) return parsed
    } catch {}
    return undefined
  }, [profileName])

  const { data: modelData, refetch, isLoading: _isLoading } = trpc.ergatai.getAgentProfileModels.useQuery(
    { profileName: profileName ?? "" },
    {
      enabled: !!profileName,
      refetchOnWindowFocus: false,
      staleTime: 5 * 60 * 1000,
      gcTime: 30 * 60 * 1000,
      placeholderData,
    },
  )

  // Persist the latest result for instant hydration next time.
  useEffect(() => {
    if (!profileName || !modelData || !Array.isArray(modelData.models) || modelData.models.length === 0) return
    try {
      localStorage.setItem(`ergatai:available-models:${profileName}`, JSON.stringify(modelData))
    } catch {}
  }, [profileName, modelData])

  // The runtime selected model is derived from the same agent snapshot that
  // carries ACP config options. This keeps `current` per-session and lets it
  // follow manual model changes made in the agent's own UI.
  const runtimeCurrentModelId = useMemo(() => {
    const raw =
      activeAgent?.current_model?.trim() ||
      extractRuntimeModelFromConfigOptions(activeAgent?.config_options)
    return raw ? normalizeModelId(raw) : null
  }, [activeAgent?.config_options, activeAgent?.current_model])

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

  // Refresh cache misses from an effect, never during render. Keep one request
  // per profile so a failed lookup cannot create a mutation loop.
  const requestedModelProfileRef = useRef<string | null>(null)

  const refreshMutation = trpc.ergatai.refreshAgentProfileModels.useMutation({
    onSuccess: (data) => {
      console.log("[useAvailableModels] Refresh success:", { profileName, modelsCount: data.models?.length ?? 0 })
      refetch()
    },
    onError: (error) => {
      console.error("[useAvailableModels] Refresh failed:", { profileName, error: error.message })
      // Allow a retry after the agent becomes ready. This covers startup races
      // where config options are not available yet.
      requestedModelProfileRef.current = null
    },
  })

  const refreshMutationRef = useRef(refreshMutation)
  // react-doctor-disable-next-line no-ref-current-in-render
  refreshMutationRef.current = refreshMutation

  useEffect(() => {
    if (!modelData || !profileName) {
      console.log("[useAvailableModels] Refresh skipped:", { hasModelData: !!modelData, profileName })
      return
    }
    if (modelData.models.length > 0) return
    if (!canRefreshModels) {
      console.log("[useAvailableModels] Refresh skipped: agent not running", {
        profileName,
        isAlive: activeAgent?.is_alive ?? false,
      })
      return
    }
    if (requestedModelProfileRef.current === profileName) return

    console.log("[useAvailableModels] Triggering refresh for profile:", profileName)
    requestedModelProfileRef.current = profileName
    refreshMutationRef.current.mutate({ profileName })
     
  // react-doctor-disable-next-line exhaustive-deps
  }, [modelData, profileName, canRefreshModels])

  // Fetch persisted runtime selected model for this agent (if any).
  const { data: agentSelectedModelRaw } = trpc.ergatai.getAgentSelectedModel.useQuery(
    { agentId: effectiveAgentId ?? "" },
    { enabled: !!effectiveAgentId, refetchOnWindowFocus: false, staleTime: 30_000 },
  )
  const agentSelectedModelId = agentSelectedModelRaw
    ? normalizeModelId(agentSelectedModelRaw)
    : null

  // Map backend response to UI format
  const backendModels = useMemo(() => {
    if (!modelData || modelData.status !== "available" || modelData.models.length === 0) {
      return null
    }

    const sourceModels = (modelData as { model_details?: { id: string; name?: string; description?: string; provider?: string }[] }).model_details
    const mapped = (sourceModels && sourceModels.length > 0
      ? sourceModels.map(mapBackendModelDetailToUI)
      : modelData.models.map(mapBackendModelToUI)
    ).filter((m): m is NonNullable<typeof m> => m !== null)

    // Deduplicate by id
    const seen = new Set<string>()
    const unique = mapped.filter((m) => {
      if (seen.has(m.id)) return false
      seen.add(m.id)
      return true
    })

    return {
      models: unique,
      current: runtimeCurrentModelId,
      defaultModel: (modelData as { default_model?: string | null } | undefined)?.default_model ? normalizeModelId((modelData as { default_model?: string | null }).default_model as string) : null,
    }
  }, [modelData, runtimeCurrentModelId])

  const lastKnownModels = useMemo(() => {
    if (modelData?.status !== "unsupported") return []
    return (modelData.last_known_models ?? [])
      .map(mapBackendModelToUI)
      .filter((m): m is NonNullable<typeof m> => m !== null)
  }, [modelData])

  const status: UseAvailableModelsReturn["status"] = backendModels
    ? "available"
    : modelData?.status === "unsupported"
      ? "unsupported"
      : "not_detected"
  const source = backendModels ? "acp_config_options" : "none"

  // No hardcoded fallback here: a generic Claude list is misleading for any
  // other ACP agent and masks the difference between cached and live state.
  const baseModels = backendModels?.models ?? []
  const currentModelId = backendModels?.current ?? null
  const defaultModelId = backendModels?.defaultModel ?? ((modelData as { default_model?: string | null } | undefined)?.default_model ? normalizeModelId((modelData as { default_model?: string | null }).default_model as string) : null)

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
      defaultModelId,
      agentSelectedModelId,
      lastKnownModels,
      status,
      source,
      verifiedAt: modelData?.verified_at ?? null,
      ollamaModels,
      recommendedModel,
      isOffline,
      hasOllama: true,
    }
  }

  return {
    models: baseModels,
    currentModelId,
    defaultModelId,
    agentSelectedModelId,
    lastKnownModels,
    status,
    source,
    verifiedAt: modelData?.verified_at ?? null,
    ollamaModels,
    recommendedModel,
    isOffline,
    hasOllama: false,
  }
}
