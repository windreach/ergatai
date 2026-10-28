/**
 * Ergatai Agent Manager — manages agent lifecycle through the Rust backend.
 *
 * Provides:
 * - spawnAgent(): Create a new agent via POST /api/v1/agents
 * - listAgents(): Get available agents via GET /api/v1/agents
 * - getActiveAgentId(): Get the currently active agent (auto-spawns if needed)
 * - Jotai atoms for reactive state
 */

import { atom } from "jotai"
import { appStore } from "../../../lib/jotai-store"
import { trpcClient } from "../../../lib/trpc"
import { createLogger } from "../../../../main/lib/logger"

const log = createLogger("AgentManager")

// ── Types ──

export interface ErgataiAgent {
  agent_id: string
  stable_id?: string
  agent_uuid: string
  workspace_id: string
  state: string
  task_id?: string
  mcp_agent_id?: string
  is_alive: boolean
  is_idle: boolean
  is_processing: boolean
  created_at: string
  last_heartbeat: string
  work_dir: string
  profile?: string
  capabilities: string[]
}

/** Agent bound to a chat (from GET /api/v1/chats/:chatId/agents) */
export interface ChatAgent {
  agent_id: string
  conversation_id: string
  state: string
  profile: string | null
  last_heartbeat: string
}

/** Result of spawning a new agent session */
export interface SpawnSessionResult {
  new_session_id: string
  new_agent_id: string
  message: string
}

interface SpawnAgentRequest {
  workspaceId?: string
  conversationId?: string
  command: string
  instruction?: string
  workDir?: string
  env?: Record<string, string>
}

class ConversationNotFoundError extends Error {
  constructor(conversationId: string) {
    super(
      `Conversation "${conversationId}" not found in backend. ` +
        `This may happen after backend restart. ` +
        `Please refresh the page or create a new chat.`
    )
    this.name = "ConversationNotFoundError"
  }
}

// ── Jotai atoms ──

/** List of available agents from the Rust backend */
export const ergataiAgentsAtom = atom<ErgataiAgent[]>([])

/** Currently active agent ID for chat routing */
export const ergataiActiveAgentIdAtom = atom<string | null>(null)

/** Loading state for agent operations */
export const ergataiAgentsLoadingAtom = atom<boolean>(false)

/** Model info per agent — includes models list and current selection */
export interface AgentModelInfo {
  models: string[]
  current?: string
  fetchedAt: number
}
export const ergataiAgentModelInfoAtom = atom<Record<string, AgentModelInfo>>({})

export interface AgentModelsResult {
  models: string[]
  current?: string
}

// ── API functions ──

/**
 * Spawn a new agent via the Rust backend.
 * Returns the agent_id of the spawned agent.
 */
export async function spawnAgent(
  request: SpawnAgentRequest
): Promise<string> {
  log.info("Spawning agent", undefined, { request })
  try {
    const result = await trpcClient.ergatai.spawnAgent.mutate(request)
    log.info("Spawn result", undefined, { result })
    // Handle both snake_case and camelCase response formats
    const resultObj = result as Record<string, unknown>
    const agentId = (resultObj.agent_id ?? resultObj.agentId) as string | undefined
    if (!agentId) {
      log.error("Backend did not return agent_id", undefined, { result })
      throw new Error("Ergatai backend did not return an agent ID")
    }
    return agentId
  } catch (error) {
    log.error("spawnAgent failed", error as Error)
    throw error
  }
}

/**
 * List all agents from the Rust backend.
 */
export async function listAgents(): Promise<ErgataiAgent[]> {
  const result = await trpcClient.ergatai.listAgents.query()
  return result as ErgataiAgent[]
}

/**
 * Kill an agent via the Rust backend.
 */
export async function killAgent(agentId: string): Promise<void> {
  await trpcClient.ergatai.killAgent.mutate({ agentId })
}

/**
 * Check for existing agent binding for a chat/conversation.
 * Returns the agent ID if a valid binding exists and the agent is alive.
 */
async function checkExistingAgentBinding(
  chatId: string,
  conversationId?: string,
): Promise<string | null> {
  try {
    const bindings = await trpcClient.ergatai.getAgentBindings.query({ chatId })
    if (!bindings || bindings.length === 0) return null

    const binding = conversationId
      ? bindings.find((candidate) => candidate.conversationId === conversationId)
      : bindings[0]

    if (!binding) return null

    const agentId = binding.agentId

    // Verify the agent is still alive
    try {
      const agents = await listAgents()
      const agent = agents.find((a) => a.agent_id === agentId)
      if (agent && agent.is_alive) {
        log.debug("Reusing bound agent", undefined, { agentId })
        return agentId
      }
    } catch {
      // Agent list failed, continue to spawn
    }

    return null
  } catch (err) {
    log.warn("Failed to get agent bindings", err as Error)
    return null
  }
}

/**
 * Validate that a conversation exists in the backend.
 * Throws an error if the conversation doesn't exist.
 */
async function validateConversationExists(conversationId: string): Promise<void> {
  try {
    const conversation = await trpcClient.ergatai.getConversation.query({
      conversationId,
    })
    if (!conversation) {
      throw new ConversationNotFoundError(conversationId)
    }
  } catch (err) {
    // If it's already our custom error, re-throw it
    if (err instanceof ConversationNotFoundError) {
      throw err
    }
    // Otherwise, wrap the error
    throw new Error(
      `Failed to verify conversation "${conversationId}": ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

/**
 * Spawn a new agent for a conversation.
 * This is the core agent creation logic.
 */
async function spawnNewAgent(
  conversationId: string,
  command: string,
): Promise<string> {
  // Validate conversation exists before spawning
  await validateConversationExists(conversationId)

  const spawnParams = {
    conversationId,
    command,
  }
  log.debug("Spawning agent with params", undefined, { spawnParams })
  const agentId = await spawnAgent(spawnParams)
  log.info("Spawned new agent", undefined, { agentId })

  // Note: Agent binding has been removed from the backend
  log.debug("Agent binding disabled - backend endpoint removed")

  return agentId
}

/**
 * Get or create an active agent for chat.
 *
 * Strategy:
 * 1. Check for existing agent binding for this chat
 * 2. If binding exists and agent is alive, use it
 * 3. Otherwise, spawn a new agent and bind it
 *
 * Uses a pending promise map to prevent race conditions when multiple
 * callers try to create an agent for the same conversation simultaneously.
 *
 * This is called by ErgataiChatTransport when it needs an agentId.
 */
export async function getOrCreateActiveAgent(
  chatId: string,
  command: string = "claude-code",
  conversationId?: string
): Promise<string> {
  // Use conversationId as the lock key to prevent duplicate agents per conversation
  const lockKey = conversationId || chatId

  // FIX #1: Create the creation promise IMMEDIATELY to lock this key BEFORE any async work.
  // Without this, two concurrent callers could both pass the pendingFetches.get check below,
  // both call checkExistingAgentBinding, both find no live agent, and both spawn new agents.
  const creationPromise = (async () => {
    // Step 1: Check for existing agent binding
    const existingAgentId = await checkExistingAgentBinding(chatId, conversationId)
    if (existingAgentId) {
      return existingAgentId
    }

    // Step 2: No valid binding found — spawn new agent
    try {
      // conversationId is required for spawn — it should always be provided by the caller.
      if (!conversationId) {
        throw new Error(
          "conversationId is required but was not provided. " +
          "This is a bug — please report it."
        )
      }

      return await spawnNewAgent(conversationId, command)
    } catch (err) {
      log.error("Failed to spawn agent", err as Error, { conversationId, command })
      const errorMessage = err instanceof Error ? err.message : String(err)

      // Provide more specific error messages
      if (errorMessage.includes("Conversation not found")) {
        throw new Error(
          `Conversation not found: ${conversationId}. ` +
          `The conversation may not have been created yet or was deleted. ` +
          `Please try refreshing the page or creating a new chat.`
        )
      }
      throw new Error(`Failed to spawn agent: ${errorMessage}`)
    }
  })()

  // Store the pending promise so concurrent callers can wait for it
  modelFetchCache.pendingFetches.set(lockKey, creationPromise)

  // Clean up the pending promise when it settles (success or failure)
  creationPromise.finally(() => {
    modelFetchCache.pendingFetches.delete(lockKey)
  })

  return creationPromise
}

/**
 * Refresh the agent list and update the Jotai atom.
 */
export async function refreshAgentList(
  setAgents: (agents: ErgataiAgent[]) => void
): Promise<void> {
  try {
    const agents = await listAgents()
    setAgents(agents)
  } catch (err) {
    log.error("Failed to refresh agent list", err as Error)
  }
}

// ── Dedup guard: skip fetch if models were fetched recently ──
const MODEL_FETCH_DEDUP_MS = 30_000 // 30 seconds

// Model fetch cache - tracks last fetch time per agent to prevent redundant requests
interface ModelFetchCache {
  lastFetchAt: Map<string, number>
  pendingFetches: Map<string, Promise<string> | Promise<{ models: string[]; current?: string } | null>>
}

const modelFetchCache: ModelFetchCache = {
  lastFetchAt: new Map(),
  pendingFetches: new Map(),
}

/**
 * Fetch model information from agent.
 *
 * Uses a two-tier fallback strategy:
 * 1. PRIMARY: ACP config_options (standard protocol approach)
 * 2. FALLBACK: Spawn temporary agent and execute /model command (for agents that don't support config_options)
 *
 * Returns the model result, or null if both methods failed.
 * Deduped: skips if another fetch completed within the last 30 seconds.
 */
export async function fetchAgentModels(
  agentId: string,
  command?: string,
  workDir?: string,
  conversationId?: string,
): Promise<{ models: string[]; current?: string } | null> {
  // Dedup: if we fetched models for this agent recently, skip
  const now = Date.now()
  const lastFetchAt = modelFetchCache.lastFetchAt.get(agentId) ?? 0
  if (now - lastFetchAt < MODEL_FETCH_DEDUP_MS) {
    log.debug("fetchAgentModels: skipped (dedup)", undefined, {
      agentId,
      lastFetchSec: Math.round((now - lastFetchAt) / 1000)
    })
    const store = appStore
    const existing = store.get(ergataiAgentModelInfoAtom)
    const agentEntry = existing[agentId]
    if (agentEntry && agentEntry.models.length > 0) {
      return { models: agentEntry.models, current: agentEntry.current }
    }
    return null
  }
  // FIX #2: Do NOT set lastFetchAt here — set it only on successful fetch
  // (inside saveModelResult). Otherwise a failed fetch would block retries
  // for MODEL_FETCH_DEDUP_MS.

  log.debug("fetchAgentModels", undefined, { agentId })

  // PRIMARY: Try ACP config_options (standard protocol approach)
  try {
    const result = await trpcClient.ergatai.getAgentConfigOptions.query({ agentId })
    const resultObj = result as Record<string, unknown>
    const configOptions = (resultObj.configOptions ?? resultObj.config_options ?? []) as Array<Record<string, unknown>>

    if (Array.isArray(configOptions) && configOptions.length > 0) {
      // Find config option with category="Model"
      const modelOption = configOptions.find((opt) => {
        const category = opt.category as string | undefined
        return category === "Model" || category === "model"
      })

      if (modelOption) {
        // Extract models from the config option
        let models: string[] = []
        let current: string | undefined

        const kind = modelOption.kind as Record<string, unknown> | undefined
        if (kind?.type === "select") {
          current = kind.currentValue as string | undefined
          const options = (kind.options ?? []) as Array<Record<string, unknown>>
          models = options.map((opt) => (opt.value ?? opt.id) as string).filter(Boolean)
        }

        if (models.length > 0) {
          log.info("fetchAgentModels: got models from ACP config_options", undefined, { models, current })
          return saveModelResult(agentId, models, current)
        }
      }
    }

    log.debug("fetchAgentModels: ACP config_options not available, trying fallback")
  } catch (err) {
    log.warn("fetchAgentModels: ACP config_options failed", err as Error)
  }

  // FALLBACK: Spawn temporary agent and execute /model command
  if (command) {
    log.debug("fetchAgentModels: using fallback (temp agent with /model command)")
    return spawnTempModelAgentFallback(command, workDir, conversationId)
  }

  log.warn("fetchAgentModels: both methods failed")
  return null
}

/**
 * Save model result to Jotai atom and SQLite database.
 * FIX #2: Also updates lastFetchAt timestamp so dedup only kicks in after success.
 */
function saveModelResult(
  agentId: string,
  models: string[],
  current: string | undefined,
): { models: string[]; current?: string } {
  // Update dedup timestamp ONLY on success (not before fetch)
  modelFetchCache.lastFetchAt.set(agentId, Date.now())

  const store = appStore
  const existing = store.get(ergataiAgentModelInfoAtom)
  store.set(ergataiAgentModelInfoAtom, {
    ...existing,
    [agentId]: {
      models,
      current,
      fetchedAt: Date.now(),
    },
  })

  // Persist to SQLite database (source of truth)
  trpcClient.ergatai.saveModelSnapshot.mutate({
    cacheKey: agentId,
    models,
    current,
  }).catch((err) => {
    log.warn("Failed to save model snapshot to SQLite", err as Error)
  })

  log.debug("fetchAgentModels: models saved", undefined, { models, current })
  return { models, current }
}

/**
 * Fallback: Spawn a temporary agent, execute /model on it, then kill it.
 * Used when ACP config_options is not supported by the agent.
 */
async function spawnTempModelAgentFallback(
  command: string,
  workDir?: string,
  conversationId?: string,
): Promise<{ models: string[]; current?: string } | null> {
  let tempAgentId: string | null = null

  try {
    // Step 1: Spawn temporary agent
    const spawnResult = await trpcClient.ergatai.spawnAgent.mutate({
      conversationId,
      temporaryAgent: true,
      command,
      workDir,
    })
    tempAgentId = spawnResult?.agent_id ?? null
    if (!tempAgentId) {
      log.error("spawnTempModelAgentFallback: no agent_id returned")
      return null
    }
    log.debug("spawnTempModelAgentFallback: spawned temp agent", undefined, { tempAgentId })

    // Step 2: Wait for agent process to start, then execute /model with retries
    const MAX_ATTEMPTS = 3
    const DELAY_MS = 1500

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, DELAY_MS))

      try {
        const result = await trpcClient.ergatai.executeAgentCommand.mutate({
          agentId: tempAgentId,
          command: "/model",
          args: [],
        })

        const resultObj = result as Record<string, unknown>
        const parsed = resultObj.parsed as Record<string, unknown> | undefined
        const output = resultObj.output as unknown
        let models: string[] = []
        let current: string | undefined

        // Strategy 1: "Current model: `xxx`" format (claude agent)
        if (typeof output === "string") {
          const currentMatch = output.match(/Current model:\s*`?(\S+?)`?\s*(?:\n|$)/i)
          if (currentMatch) current = currentMatch[1]
        }

        // Strategy 2: structured parsed.current
        if (!current && parsed?.current) current = parsed.current as string

        // Strategy 3: "Model metadata for `xxx`" warning (codex agent)
        if (!current && typeof output === "string") {
          const metadataMatch = output.match(/Model metadata for `([^`]+)`/i)
          if (metadataMatch) current = metadataMatch[1]
        }

        // Strategy 4: backtick-quoted model names
        if (!current && typeof output === "string") {
          const backtickModels = output.match(/`([a-zA-Z0-9][a-zA-Z0-9._\-\/]+[a-zA-Z0-9])`/g)
          if (backtickModels) {
            const candidates = backtickModels
              .map((m) => m.replace(/`/g, ""))
              .filter((m) => m.length >= 3 && m.length <= 60 && !m.includes(" ") && /^[a-zA-Z0-9][a-zA-Z0-9._\-\/:]+$/.test(m))
            if (candidates.length > 0) current = candidates[0]
          }
        }

        if (current) models = [current]

        // Strategy 5: parsed.models array
        if (models.length === 0 && parsed?.models && Array.isArray(parsed.models)) {
          models = [...new Set(parsed.models as string[])]
          if (!current && parsed.current) current = parsed.current as string
        }
        if (models.length > 0) {
          log.info("spawnTempModelAgentFallback: models fetched", undefined, { models, current })
          return saveModelResult(tempAgentId, models, current)
        }

        log.debug("spawnTempModelAgentFallback: empty result", undefined, { attempt, maxAttempts: MAX_ATTEMPTS })
      } catch (cmdErr) {
        log.warn("spawnTempModelAgentFallback: command failed", cmdErr as Error, { attempt, maxAttempts: MAX_ATTEMPTS })
      }
    }

    log.warn("spawnTempModelAgentFallback: all attempts exhausted, no models found")
    return null
  } catch (err) {
    log.warn("spawnTempModelAgentFallback failed", err as Error)
    return null
  } finally {
    // Step 3: Always kill temp agent (fire-and-forget to avoid blocking)
    if (tempAgentId) {
      trpcClient.ergatai.killAgent.mutate({ agentId: tempAgentId })
        .then(() => {
          log.debug("spawnTempModelAgentFallback: killed temp agent", undefined, { tempAgentId })
        })
        .catch((err) => {
          // FIX #3: Log failures so orphaned agents can be diagnosed
          log.warn("spawnTempModelAgentFallback: failed to kill temp agent (may be orphaned)", err as Error, { tempAgentId })
        })
    }
  }
}

/**
 * Get all agents bound to a chat.
 * Used for agent-to-agent routing to determine if target agent already exists.
 */
export async function getChatAgents(chatId: string): Promise<ChatAgent[]> {
  try {
    return await trpcClient.ergatai.getChatAgents.query({ chatId })
  } catch (err) {
    log.warn("Failed to get chat agents", err as Error)
    return []
  }
}

/**
 * Send a message from one agent to another (agent-to-agent communication).
 *
 * The backend will:
 * 1. Check if the target agent is already bound to this chat
 * 2. If yes and alive → route to existing agent
 * 3. If no or dead → spawn new agent and bind it
 * 4. If forceNewSession is true → always spawn new agent
 *
 * @param fromAgentId - The sending agent's ID
 * @param targetAgentCommand - The target agent type (e.g., "claude", "codex")
 * @param message - The message content
 * @param options - Additional options
 * @returns The target agent ID and session ID (if available)
 */
export async function sendAgentToAgentMessage(
  fromAgentId: string,
  targetAgentCommand: string,
  message: string,
  options: {
    chatId?: string
    conversationId?: string
    forceNewSession?: boolean
    correlationId?: string
  } = {}
): Promise<{ targetAgentId: string | null; sessionId: string | null; status: string }> {
  log.info("Sending agent-to-agent message", undefined, {
    fromAgentId,
    targetAgentCommand,
    forceNewSession: options.forceNewSession,
  })

  try {
    const result = await trpcClient.ergatai.sendMessage.mutate({
      agentId: fromAgentId,
      message,
      from: fromAgentId,
      messageType: "request",
      targetAgentCommand,
      forceNewSession: options.forceNewSession,
      correlationId: options.correlationId,
      conversationId: options.conversationId,
    })

    // Backend response varies based on implementation status
    // New implementation returns: { status, target_agent_id, session_id, reused }
    // Fallback for older backends: { status, target_agent, stream }
    const resultObj = result as Record<string, unknown>
    const targetAgentId = (resultObj.target_agent_id ?? resultObj.target_agent ?? null) as string | null
    const sessionId = (resultObj.session_id ?? resultObj.stream ?? null) as string | null
    const status = (resultObj.status ?? "unknown") as string

    log.info("Agent-to-agent message result", undefined, {
      targetAgentId,
      sessionId,
      status,
    })

    return { targetAgentId, sessionId, status }
  } catch (err) {
    log.error("Failed to send agent-to-agent message", err as Error)
    throw err
  }
}

/**
 * Explicitly spawn a new agent session.
 * Used when an agent requests a new session (e.g., context overflow, task separation).
 *
 * @param agentId - The requesting agent's ID
 * @param targetCommand - The target agent type to spawn
 * @param reason - Why a new session is needed
 * @param options - Additional options
 */
export async function spawnNewAgentSession(
  agentId: string,
  targetCommand: string,
  reason: "explicit_request" | "context_overflow" | "task_separation" = "explicit_request",
  options: {
    inheritContext?: boolean
    workspaceId?: string
  } = {}
): Promise<SpawnSessionResult> {
  log.info("Spawning new agent session", undefined, {
    agentId,
    targetCommand,
    reason,
  })

  try {
    const result = await trpcClient.ergatai.spawnAgentSession.mutate({
      agentId,
      targetCommand,
      reason,
      inheritContext: options.inheritContext,
      workspaceId: options.workspaceId,
    })

    log.info("New session spawned", undefined, { result })
    return result
  } catch (err) {
    log.error("Failed to spawn new session", err as Error)
    throw err
  }
}
