/**
 * Model Snapshot Manager — Cache manager for agent model lists
 *
 * Provides:
 * - Stable cache key derivation from agent identity (profile + workspace_id)
 * - Generation-based write ordering (prevents stale overwrites)
 * - Promise-based deduplication (prevents concurrent refreshes)
 * - Agent idle state checking before executing /model
 * - Only persists successfully parsed, non-empty model lists
 */

import { ergataiFetch } from "./ergatai/api"
import {
  loadSnapshots,
  saveSnapshots,
  type ModelSnapshot,
  type ModelSnapshotStore,
} from "./model-snapshot-store"

// ── Types ──

export interface AgentModelsResult {
  models: string[]
  current?: string
  isStale: boolean
}

export interface ErgataiAgent {
  agent_id: string
  stable_id?: string | null
  workspace_id: string
  profile?: string | null
  is_alive: boolean
  is_idle: boolean
  is_processing: boolean
}

// ── Singleton ──

let managerInstance: ModelSnapshotManager | null = null

export function getModelSnapshotManager(): ModelSnapshotManager {
  if (!managerInstance) {
    managerInstance = new ModelSnapshotManager()
  }
  return managerInstance
}

// ── Manager Class ──

export class ModelSnapshotManager {
  private snapshots: ModelSnapshotStore = {}
  private generations: Map<string, number> = new Map()
  private pendingRefreshes: Map<string, Promise<AgentModelsResult>> = new Map()
  private initialized: boolean = false

  /**
   * Initialize the manager by loading snapshots from disk.
   * Must be called on app startup before any operations.
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return
    }

    this.snapshots = await loadSnapshots()

    // Restore generation counters from loaded snapshots
    for (const [cacheKey, snapshot] of Object.entries(this.snapshots)) {
      this.generations.set(cacheKey, snapshot.generation)
    }

    this.initialized = true
    console.log(
      `[ModelSnapshotManager] Initialized with ${Object.keys(this.snapshots).length} snapshots`,
    )
  }

  /**
   * Derive stable cache key from agent identity.
   * Uses profile + workspace_id (NOT ephemeral agent_id).
   */
  deriveCacheKey(agent: ErgataiAgent): string {
    // Use profile if available, otherwise fall back to stable_id
    const profile = agent.profile || agent.stable_id || "default"
    const workspace = agent.workspace_id || "unknown"
    return `${profile}:${workspace}`
  }

  /**
   * Get cached snapshot for a cache key.
   * Returns undefined if no snapshot exists.
   */
  async getSnapshot(cacheKey: string): Promise<ModelSnapshot | undefined> {
    if (!this.initialized) {
      await this.initialize()
    }
    return this.snapshots[cacheKey]
  }

  /**
   * Save snapshot with generation ordering protection.
   * Only saves if models array is non-empty.
   * Prevents older responses from overwriting newer snapshots.
   */
  async saveSnapshot(
    cacheKey: string,
    models: string[],
    current: string | undefined,
    isStale: boolean,
  ): Promise<void> {
    if (!this.initialized) {
      await this.initialize()
    }

    // Never persist empty model lists
    if (!models || models.length === 0) {
      console.warn(`[ModelSnapshotManager] Refusing to save empty model list for ${cacheKey}`)
      return
    }

    // Get current generation and increment
    const currentGen = this.generations.get(cacheKey) || 0
    const newGen = currentGen + 1

    // Check if existing snapshot is newer (generation ordering)
    const existing = this.snapshots[cacheKey]
    if (existing && existing.generation >= newGen) {
      console.log(
        `[ModelSnapshotManager] Skipping save for ${cacheKey}: existing generation ${existing.generation} >= new ${newGen}`,
      )
      return
    }

    // Save new snapshot
    this.snapshots[cacheKey] = {
      models,
      current,
      generation: newGen,
      timestamp: Date.now(),
      isStale,
    }

    // Update generation counter
    this.generations.set(cacheKey, newGen)

    // Persist to disk
    await saveSnapshots(this.snapshots)
    console.log(`[ModelSnapshotManager] Saved snapshot for ${cacheKey} (generation ${newGen})`)
  }

  /**
   * Refresh models with deduplication.
   * Deduplicates concurrent refresh requests for same cache key.
   *
   * Note: Removed idle state checking - the backend can handle /model commands
   * even when the agent is busy processing other messages (confirmed via debug logs).
   */
  async refreshModels(agent: ErgataiAgent, forceRefresh: boolean = false): Promise<AgentModelsResult> {
    if (!this.initialized) {
      await this.initialize()
    }

    const cacheKey = this.deriveCacheKey(agent)

    // Check if refresh already in progress for this cache key
    const pending = this.pendingRefreshes.get(cacheKey)
    if (pending) {
      console.log(`[ModelSnapshotManager] Refresh already in progress for ${cacheKey}, reusing promise`)
      return pending
    }

    // Create refresh promise (no idle check - backend handles busy agents)
    const refreshPromise = this.doRefresh(agent, cacheKey)
    this.pendingRefreshes.set(cacheKey, refreshPromise)

    try {
      return await refreshPromise
    } finally {
      this.pendingRefreshes.delete(cacheKey)
    }
  }

  /**
   * Execute the actual /model command and save result.
   * Only saves if successfully parsed and non-empty.
   * Retries with backoff if the agent isn't ready yet (just spawned).
   */
  private async doRefresh(agent: ErgataiAgent, cacheKey: string): Promise<AgentModelsResult> {
    const MAX_ATTEMPTS = 2
    const INITIAL_DELAY_MS = 1000  // Wait 1s before first attempt (agent startup time)
    const RETRY_DELAY_MS = 1500

    // Initial delay to let agent process start
    console.log(`[ModelSnapshotManager] Waiting ${INITIAL_DELAY_MS}ms for agent ${agent.agent_id} to initialize...`)
    await new Promise((resolve) => setTimeout(resolve, INITIAL_DELAY_MS))

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        console.log(`[ModelSnapshotManager] Executing /model command for agent ${agent.agent_id} (attempt ${attempt}/${MAX_ATTEMPTS})`)
        const result = await ergataiFetch<any>(
          `/api/v1/agents/${agent.agent_id}/execute-command`,
          {
            method: "POST",
            body: JSON.stringify({ command: "/model", args: [] }),
          },
        )

        console.log(`[ModelSnapshotManager] Raw response from backend (attempt ${attempt}):`, JSON.stringify(result, null, 2))

        const parsed = result?.parsed
        const output = result?.output
        let models: string[] = []
        let current: string | undefined

        // Strategy 1: Parse "Current model: `xxx`" format (claude agent)
        if (typeof output === "string") {
          const currentMatch = output.match(/Current model:\s*`?(\S+?)`?\s*(?:\n|$)/i)
          if (currentMatch) {
            current = currentMatch[1]
          }
        }

        // Strategy 2: Use parsed.current if available (structured response)
        if (!current && parsed?.current) {
          current = parsed.current as string
        }

        // Strategy 3: Extract model name from "Model metadata for `xxx`" warnings (codex agent)
        if (!current && typeof output === "string") {
          const metadataMatch = output.match(/Model metadata for `([^`]+)`/i)
          if (metadataMatch) {
            current = metadataMatch[1]
            console.log(`[ModelSnapshotManager] Extracted model from metadata warning: ${current}`)
          }
        }

        // Strategy 4: Extract model-like names from backtick-quoted strings in output
        if (!current && typeof output === "string") {
          const backtickModels = output.match(/`([a-zA-Z0-9][a-zA-Z0-9._\-\/]+[a-zA-Z0-9])`/g)
          if (backtickModels) {
            const modelCandidates = backtickModels
              .map((m) => m.replace(/`/g, ""))
              .filter((m) => {
                // Filter out things that don't look like model names
                if (m.length < 3 || m.length > 60) return false
                if (m.includes(" ") || m.includes("\n")) return false
                // Must contain at least one letter and look like a model identifier
                return /^[a-zA-Z0-9][a-zA-Z0-9._\-\/:]+$/.test(m)
              })
            if (modelCandidates.length > 0) {
              current = modelCandidates[0]
              console.log(`[ModelSnapshotManager] Extracted model from backtick pattern: ${current}`)
            }
          }
        }

        // Build models list from current
        if (current) {
          models = [current]
        }

        // Strategy 5: Use parsed.models if above failed (structured response)
        if (models.length === 0 && parsed?.models && Array.isArray(parsed.models)) {
          models = [...new Set(parsed.models as string[])]
          if (!current && parsed.current) {
            current = parsed.current as string
          }
        }

        console.log(`[ModelSnapshotManager] Parsed models (attempt ${attempt}):`, models, "current:", current)

        if (models.length > 0) {
          await this.saveSnapshot(cacheKey, models, current, false)
          return { models, current, isStale: false }
        }

        // Empty result — retry if agent might not be ready yet
        if (attempt < MAX_ATTEMPTS) {
          console.log(`[ModelSnapshotManager] Empty models, retrying in ${RETRY_DELAY_MS}ms (attempt ${attempt}/${MAX_ATTEMPTS})`)
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS))
          continue
        }

        // All attempts exhausted — return existing snapshot if any
        console.warn(`[ModelSnapshotManager] Empty models after ${MAX_ATTEMPTS} attempts for ${cacheKey}, returning cached`)
        const existing = await this.getSnapshot(cacheKey)
        if (existing) {
          return { models: existing.models, current: existing.current, isStale: true }
        }

        return { models: [], current: undefined, isStale: true }
      } catch (err) {
        console.error(`[ModelSnapshotManager] Refresh failed (attempt ${attempt}/${MAX_ATTEMPTS}) for ${cacheKey}:`, err)

        // Retry on error if agent might not be ready
        if (attempt < MAX_ATTEMPTS) {
          console.log(`[ModelSnapshotManager] Retrying in ${RETRY_DELAY_MS}ms after error`)
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS))
          continue
        }

        // All attempts exhausted
        const existing = await this.getSnapshot(cacheKey)
        if (existing) {
          return { models: existing.models, current: existing.current, isStale: true }
        }
        return { models: [], current: undefined, isStale: true }
      }
    }

    // Should not reach here, but TypeScript requires a return
    return { models: [], current: undefined, isStale: true }
  }

  /**
   * Get models with cache support.
   * Returns cached snapshot if available (unless forceRefresh is true).
   * Otherwise triggers a refresh.
   */
  async getModelsWithCache(
    agent: ErgataiAgent,
    forceRefresh: boolean = false,
  ): Promise<AgentModelsResult & { isCached: boolean; timestamp?: number }> {
    if (!this.initialized) {
      await this.initialize()
    }

    const cacheKey = this.deriveCacheKey(agent)

    // Check cache first (unless force refresh)
    if (!forceRefresh) {
      const cached = await this.getSnapshot(cacheKey)
      if (cached) {
        return {
          models: cached.models,
          current: cached.current,
          isStale: cached.isStale,
          isCached: true,
          timestamp: cached.timestamp,
        }
      }
    }

    // Refresh through manager (handles deduplication)
    const result = await this.refreshModels(agent, forceRefresh)
    return {
      ...result,
      isCached: false,
      timestamp: Date.now(),
    }
  }
}
