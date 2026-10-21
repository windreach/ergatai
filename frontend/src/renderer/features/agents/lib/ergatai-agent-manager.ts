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

// ── Jotai atoms ──

/** List of available agents from the Rust backend */
export const ergataiAgentsAtom = atom<ErgataiAgent[]>([])

/** Currently active agent ID for chat routing */
export const ergataiActiveAgentIdAtom = atom<string | null>(null)

/** Loading state for agent operations */
export const ergataiAgentsLoadingAtom = atom<boolean>(false)

/** Available models per agent (fetched from backend /model command) */
export const ergataiAgentModelsAtom = atom<Record<string, string[]>>({})

/** Model info per agent — includes models list and current selection */
export interface AgentModelInfo {
  models: string[]
  current?: string
  fetchedAt: number
}
export const ergataiAgentModelInfoAtom = atom<Record<string, AgentModelInfo>>({})

/** Pending agent creation promises to prevent race conditions */
const pendingAgentCreations = new Map<string, Promise<string>>()

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
  console.log("[ErgataiAgentManager] Spawning agent with request:", request)
  try {
    const result = await trpcClient.ergatai.spawnAgent.mutate(request)
    console.log("[ErgataiAgentManager] Spawn result:", JSON.stringify(result))
    const agentId = result?.agent_id ?? (result as { agentId?: string })?.agentId
    if (!agentId) {
      console.error("[ErgataiAgentManager] Backend did not return agent_id. Full result:", result)
      throw new Error("Ergatai backend did not return an agent ID")
    }
    return agentId
  } catch (error) {
    console.error("[ErgataiAgentManager] spawnAgent failed:", error)
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

  // Check if there's already a pending creation for this conversation
  const pending = pendingAgentCreations.get(lockKey)
  if (pending) {
    console.log("[ErgataiAgentManager] Waiting for pending agent creation:", lockKey)
    return pending
  }

  // Step 1: Check for existing agent binding for this chat
  try {
    const bindings = await trpcClient.ergatai.getAgentBindings.query({ chatId })
    if (bindings && bindings.length > 0) {
      const binding = conversationId
        ? bindings.find((candidate) => candidate.conversationId === conversationId)
        : bindings[0]
      if (binding) {
        const agentId = binding.agentId

        // Verify the agent is still alive
        try {
          const agents = await listAgents()
          const agent = agents.find((a) => a.agent_id === agentId)
          if (agent && agent.is_alive) {
            console.log("[ErgataiAgentManager] Reusing bound agent:", agentId)
            return agentId
          }
        } catch {
          // Agent list failed, continue to spawn
        }
      }
    }
  } catch (err) {
    console.warn("[ErgataiAgentManager] Failed to get agent bindings:", err)
  }

  // Step 2: No valid binding found — spawn new agent (with lock)
  const creationPromise = (async () => {
    try {
      // conversationId is required for spawn — it should always be provided by the caller.
      // If missing, this is a programming error, not a fallback scenario.
      if (!conversationId) {
        throw new Error(
          "conversationId is required but was not provided. " +
          "This is a bug — please report it."
        )
      }

      // Validate conversationId exists in backend before spawning.
      // localStorage may persist stale conversationIds from previous sessions
      // that no longer exist after backend restart.
      try {
        const conversation = await trpcClient.ergatai.getConversation.query({
          conversationId,
        })
        if (!conversation) {
          throw new Error(
            `Conversation "${conversationId}" not found in backend. ` +
            `This may happen after backend restart. ` +
            `Please refresh the page or create a new chat.`
          )
        }
      } catch (err) {
        // If it's already our custom error, re-throw it
        if (err instanceof Error && err.message.includes("not found in backend")) {
          throw err
        }
        // Otherwise, wrap the error
        throw new Error(
          `Failed to verify conversation "${conversationId}": ${err instanceof Error ? err.message : String(err)}`
        )
      }

      const spawnParams = {
        conversationId,
        command,
      }
      console.log("[ErgataiAgentManager] Spawning agent with params:", spawnParams)
      const agentId = await spawnAgent(spawnParams)
      console.log("[ErgataiAgentManager] Spawned new agent:", agentId)

      // Step 3: Backend no longer supports agent binding
      // Agent binding has been removed from the backend
      console.log("[ErgataiAgentManager] Agent binding disabled - backend endpoint removed")

      return agentId
    } catch (err) {
      console.error("[ErgataiAgentManager] Failed to spawn agent:", err)
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
    } finally {
      // Clean up the pending promise
      pendingAgentCreations.delete(lockKey)
    }
  })()

  // Store the pending promise so concurrent callers can wait for it
  pendingAgentCreations.set(lockKey, creationPromise)
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
    console.error("[ErgataiAgentManager] Failed to refresh agent list:", err)
  }
}

// ── Dedup guard: skip fetch if models were fetched recently ──
const MODEL_FETCH_DEDUP_MS = 30_000 // 30 seconds
let lastModelFetchAt = 0

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
  // Dedup: if we fetched models recently, skip
  const now = Date.now()
  if (now - lastModelFetchAt < MODEL_FETCH_DEDUP_MS) {
    console.log("[ErgataiAgentManager] fetchAgentModels: skipped (dedup, last fetch", Math.round((now - lastModelFetchAt) / 1000), "s ago)")
    const store = appStore
    const existing = store.get(ergataiAgentModelInfoAtom)
    const latest = Object.values(existing).reduce((a, b) => (a.fetchedAt > b.fetchedAt ? a : b), { models: [] as string[], fetchedAt: 0 })
    if (latest.models.length > 0) {
      return { models: latest.models, current: latest.current }
    }
    return null
  }
  lastModelFetchAt = now

  console.log("[ErgataiAgentManager] fetchAgentModels: agentId=", agentId)

  // PRIMARY: Try ACP config_options (standard protocol approach)
  try {
    const result = await trpcClient.ergatai.getAgentConfigOptions.query({ agentId })
    const configOptions = (result as any)?.configOptions || (result as any)?.config_options || []

    if (Array.isArray(configOptions) && configOptions.length > 0) {
      // Find config option with category="Model"
      const modelOption = configOptions.find((opt: any) => opt.category === "Model" || opt.category === "model")

      if (modelOption) {
        // Extract models from the config option
        let models: string[] = []
        let current: string | undefined

        if (modelOption.kind?.type === "select") {
          current = modelOption.kind.currentValue
          const options = modelOption.kind.options || []
          models = options.map((opt: any) => opt.value || opt.id).filter(Boolean)
        }

        if (models.length > 0) {
          console.log("[ErgataiAgentManager] fetchAgentModels: got models from ACP config_options:", models, "current:", current)
          return saveModelResult(agentId, models, current)
        }
      }
    }

    console.log("[ErgataiAgentManager] fetchAgentModels: ACP config_options not available or no Model category, trying fallback...")
  } catch (err) {
    console.warn("[ErgataiAgentManager] fetchAgentModels: ACP config_options failed:", err)
  }

  // FALLBACK: Spawn temporary agent and execute /model command
  if (command) {
    console.log("[ErgataiAgentManager] fetchAgentModels: using fallback (temp agent with /model command)")
    return spawnTempModelAgentFallback(command, workDir, conversationId)
  }

  console.warn("[ErgataiAgentManager] fetchAgentModels: both methods failed")
  return null
}

/**
 * Save model result to Jotai atom and SQLite database.
 */
function saveModelResult(
  agentId: string,
  models: string[],
  current: string | undefined,
): { models: string[]; current?: string } {
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
    console.warn("[ErgataiAgentManager] Failed to save model snapshot to SQLite:", err)
  })

  console.log("[ErgataiAgentManager] fetchAgentModels: models saved:", models, "current:", current)
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
      command,
      workDir,
    })
    tempAgentId = spawnResult?.agent_id ?? null
    if (!tempAgentId) {
      console.error("[ErgataiAgentManager] spawnTempModelAgentFallback: no agent_id returned")
      return null
    }
    console.log("[ErgataiAgentManager] spawnTempModelAgentFallback: spawned temp agent:", tempAgentId)

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

        const parsed = (result as any)?.parsed
        const output = (result as any)?.output
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
          console.log("[ErgataiAgentManager] spawnTempModelAgentFallback: models fetched:", models, "current:", current)
          return saveModelResult(tempAgentId, models, current)
        }

        console.log("[ErgataiAgentManager] spawnTempModelAgentFallback: empty result, attempt", attempt, "/", MAX_ATTEMPTS)
      } catch (cmdErr) {
        console.warn("[ErgataiAgentManager] spawnTempModelAgentFallback: command failed, attempt", attempt, "/", MAX_ATTEMPTS, cmdErr)
      }
    }

    console.warn("[ErgataiAgentManager] spawnTempModelAgentFallback: all attempts exhausted, no models found")
    return null
  } catch (err) {
    console.warn("[ErgataiAgentManager] spawnTempModelAgentFallback failed:", err)
    return null
  } finally {
    // Step 3: Always kill temp agent (fire-and-forget to avoid blocking)
    if (tempAgentId) {
      trpcClient.ergatai.killAgent.mutate({ agentId: tempAgentId })
        .then(() => {
          console.log("[ErgataiAgentManager] spawnTempModelAgentFallback: killed temp agent:", tempAgentId)
        })
        .catch(() => {
          // Ignore — agent may have already exited
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
    console.warn("[ErgataiAgentManager] Failed to get chat agents:", err)
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
  console.log("[ErgataiAgentManager] Sending agent-to-agent message:", {
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
    const targetAgentId = (result as any)?.target_agent_id ?? (result as any)?.target_agent ?? null
    const sessionId = (result as any)?.session_id ?? (result as any)?.stream ?? null
    const status = (result as any)?.status ?? "unknown"

    console.log("[ErgataiAgentManager] Agent-to-agent message result:", {
      targetAgentId,
      sessionId,
      status,
    })

    return { targetAgentId, sessionId, status }
  } catch (err) {
    console.error("[ErgataiAgentManager] Failed to send agent-to-agent message:", err)
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
  console.log("[ErgataiAgentManager] Spawning new agent session:", {
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

    console.log("[ErgataiAgentManager] New session spawned:", result)
    return result
  } catch (err) {
    console.error("[ErgataiAgentManager] Failed to spawn new session:", err)
    throw err
  }
}
