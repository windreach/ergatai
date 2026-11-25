import i18n from "@/lib/i18n"
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
import { trpcClient } from "../../../lib/trpc"
import { ensureAgentForConversation } from "./agent-session-api"
import { clearSubagentState } from "./subagent-message-store"
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
      i18n.t("Conversation \"{{id}}\" not found in backend. ", { id: conversationId }) +
        i18n.t("This may happen after backend restart. ") +
        i18n.t("Please refresh the page or create a new chat.")
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

/** In-flight agent creation promises, keyed by conversation/chat lock. */

// ── API functions ──

/**
 * Spawn a new agent via the Rust backend.
 * Returns the agent_id of the spawned agent.
 */

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
  clearSubagentState(agentId)
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
        log.debug(i18n.t('Reusing bound agent'), undefined, { agentId })
        return agentId
      }
    } catch {
      // Agent list failed, continue to spawn
    }

    return null
  } catch (err) {
    log.warn(i18n.t('Failed to get agent bindings'), err as Error)
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
      i18n.t("Failed to verify conversation \"{{id}}\": {{message}}", { id: conversationId, message: err instanceof Error ? err.message : String(err) })
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

  // Use the canonical ensure path. The backend resolves the conversation's
  // durable model selection, resumes a suspended agent when possible, and
  // applies the model before returning. Callers must not send `model` here:
  // doing so would re-create the old "some spawn paths carry a model, others
  // do not" inconsistency.
  const ensureParams = {
    conversationId,
    profile: command,
    mode: "ensure" as const,
  }
  log.debug(i18n.t('Ensuring agent with params'), undefined, { ensureParams })
  const result = await ensureAgentForConversation(ensureParams)
  const agentId = result?.agent_id
  if (!agentId) {
    throw new Error(i18n.t('Ergatai backend did not return an agent ID'))
  }
  log.info(i18n.t('Ensured agent'), undefined, {
    agentId,
    action: result.action,
    model: result.model?.selection?.id,
  })

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
// Module-level map of in-flight agent creation promises, keyed by chatId
// (and conversationId when provided) to dedup concurrent creations.
const activeAgentCreationPromises = new Map<string, Promise<string>>()

export async function getOrCreateActiveAgent(
  chatId: string,
  command: string = "claude",
  conversationId?: string
): Promise<string> {
  const key = conversationId ? `${chatId}:${conversationId}` : chatId

  // Reuse an in-flight creation for the same key.
  const existingPromise = activeAgentCreationPromises.get(key)
  if (existingPromise) {
    return existingPromise
  }

  // FIX #1: Create the creation promise IMMEDIATELY to lock this key BEFORE unknown async work.
  // Without this, two concurrent callers could both pass the pendingFetches.get check below,
  // both call checkExistingAgentBinding, both find no live agent, and both spawn new agents.
  const creationPromise = (async () => {
    try {
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
            i18n.t('This is a bug — please report it.')
          )
        }

        return await spawnNewAgent(conversationId, command)
      } catch (err) {
        log.error(i18n.t('Failed to spawn agent'), err as Error, { conversationId, command })
        const errorMessage = err instanceof Error ? err.message : String(err)

        // Provide more specific error messages
        if (errorMessage.includes(i18n.t('Conversation not found'))) {
          throw new Error(
            i18n.t("Conversation not found: {{id}}. ", { id: conversationId }) +
            i18n.t("The conversation may not have been created yet or was deleted. ") +
            i18n.t("Please try refreshing the page or creating a new chat.")
          )
        }
        throw new Error(i18n.t("Failed to spawn agent: {{message}}", { message: errorMessage }))
      }
    } finally {
      // Clean up map entry to avoid stale promises.
      activeAgentCreationPromises.delete(key)
    }
  })()

  // Store the promise in cache synchronously before returning.
  activeAgentCreationPromises.set(key, creationPromise)

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
    log.error(i18n.t('Failed to refresh agent list'), err as Error)
  }
}
/**
 * Get all agents bound to a chat.
 * Used for agent-to-agent routing to determine if target agent already exists.
 */
export async function getChatAgents(chatId: string): Promise<{ agents: ChatAgent[]; all_idle: boolean }> {
  try {
    const response = await trpcClient.ergatai.getChatAgents.query({ chatId })
    return {
      agents: response.agents ?? [],
      all_idle: response.all_idle ?? true,
    }
  } catch (err) {
    log.warn(i18n.t('Failed to get chat agents'), err as Error)
    return { agents: [], all_idle: true }
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
  log.info(i18n.t('Sending agent-to-agent message'), undefined, {
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

    log.info(i18n.t('Agent-to-agent message result'), undefined, {
      targetAgentId,
      sessionId,
      status,
    })

    return { targetAgentId, sessionId, status }
  } catch (err) {
    log.error(i18n.t('Failed to send agent-to-agent message'), err as Error)
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
  log.info(i18n.t('Spawning new agent session'), undefined, {
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

    log.info(i18n.t('New session spawned'), undefined, { result })
    return result
  } catch (err) {
    log.error(i18n.t('Failed to spawn new session'), err as Error)
    throw err
  }
}