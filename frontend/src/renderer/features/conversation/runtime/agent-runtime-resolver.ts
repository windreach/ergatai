/**
 * Agent Runtime Resolver
 *
 * Resolves agent runtime state from resolved conversation. This resolver is
 * responsible for:
 * - Checking if agent exists and is alive
 * - Determining if agent can be started
 * - Resolving agent-to-agent communication context
 * - Determining if message should be queued
 *
 * Phase 5: Initial implementation.
 * Phase 14: Integrated actual agent runtime status store for real-time agent state.
 *
 * This resolver will be used by ConversationInvocationService to resolve agent runtime.
 */

import type {
  ResolvedConversation,
  ResolvedAgentRuntime,
} from "./contracts"

import { getAgentRuntimeStatusState, refreshAgentRuntimeStatus } from "../../agents/lib/agent-runtime-status-store"
import { agentContractApi } from "../../agents/lib/agent-contract-api"

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Normalize provider/profile name for comparison.
 *
 * Handles case-insensitive matching and common naming variations:
 * - "claude-code", "claude code", "Claude-Code", "CLAUDE_CODE" all normalize to "claudecode"
 *
 * @param name - Name to normalize
 * @returns Normalized name (lowercase, no hyphens/spaces/underscores)
 */
function normalizeProviderName(name: string): string {
  return name.toLowerCase().replace(/[-\s_]/g, "")
}

// ============================================================================
// RESOLVER INTERFACE - Public API
// ============================================================================

/**
 * Agent Runtime Resolver interface.
 */
export interface AgentRuntimeResolver {
  /**
   * Resolve agent runtime state from resolved conversation.
   *
   * @param conversation - Resolved conversation
   * @returns Resolved agent runtime
   */
  resolve(conversation: ResolvedConversation): Promise<ResolvedAgentRuntime>
}

// ============================================================================
// RESOLVER IMPLEMENTATION
// ============================================================================

/**
 * Agent Runtime Resolver implementation.
 *
 * Phase 5: Initial implementation with simplified agent status checks.
 * Phase 14: Integrated actual agent runtime status store and profile registry.
 *
 * This resolver now:
 * - Queries the agent runtime status store (polls backend every 5s) for agent alive status
 * - Checks agent profile registry to determine if agent can be started
 * - Handles edge cases: agent not found, agent stopped, agent can be restarted
 *
 * The resolver uses cached state from the status store to avoid redundant API calls.
 * The status store is shared across the application and kept up-to-date via polling.
 */
class AgentRuntimeResolverImpl implements AgentRuntimeResolver {
  /**
   * Resolve agent runtime state.
   *
   * @param conversation - Resolved conversation
   * @returns Resolved agent runtime
   */
  async resolve(conversation: ResolvedConversation): Promise<ResolvedAgentRuntime> {
    const { agentId, provider, mode } = conversation

    // For normal mode without agent, return a "no agent" result
    if (mode === "normal" && !agentId) {
      return {
        agentId: null,
        provider,
        isAlive: true, // No agent to check, assume ready
        canStart: true,
      }
    }

    // For agent mode, check agent status
    if (mode === "agent" && agentId) {
      const isAlive = await this.checkAgentAlive(agentId)
      const canStart = isAlive || (await this.canStartAgent(agentId))

      if (!isAlive && !canStart) {
        return {
          agentId,
          provider,
          isAlive: false,
          canStart: false,
          reason: "agent-stopped",
          shouldQueue: true, // Queue message if agent can be started later
        }
      }

      return {
        agentId,
        provider,
        isAlive,
        canStart,
      }
    }

    // For group mode, check all participants
    if (mode === "group") {
      // Group mode is more complex - for now, assume ready
      // Future: Check all participant agents
      return {
        agentId: agentId ?? null,
        provider,
        isAlive: true,
        canStart: true,
      }
    }

    // Default: assume ready
    return {
      agentId: agentId ?? null,
      provider,
      isAlive: true,
      canStart: true,
    }
  }

  /**
   * Check if an agent is alive.
   *
   * Phase 14: Integrated with agent runtime status store to query actual agent state.
   * The status store polls the backend every 5 seconds and maintains a cache of
   * agent states. We check the cached state to avoid redundant API calls.
   *
   * Phase 16: Fixed to refresh cache if empty or stale.
   * If the store has never been updated (e.g., no React hook subscribed yet),
   * we manually refresh to ensure we have current data.
   *
   * @param agentId - Agent ID
   * @returns Whether agent is alive
   */
  private async checkAgentAlive(agentId: string): Promise<boolean> {
    // Query the agent runtime status store for current agent state
    const statusState = getAgentRuntimeStatusState()

    // If cache is empty or never updated, refresh it
    // This can happen if the resolver is called before any React hook subscribes
    if (!statusState.updatedAt || statusState.agents.length === 0) {
      try {
        await refreshAgentRuntimeStatus()
        // Re-read the state after refresh
        const refreshedState = getAgentRuntimeStatusState()
        const agent = refreshedState.agents.find((a) => a.id === agentId)
        if (!agent) {
          return false
        }
        return agent.isAlive
      } catch (error) {
        console.warn("[AgentRuntimeResolver] Failed to refresh agent status:", error)
        return false
      }
    }

    // Find the agent in the cached agents list
    let agent = statusState.agents.find((a) => a.id === agentId)

    // If agent not found in cache, attempt a refresh
    // This handles the case where an agent was just created and hasn't been
    // picked up by the polling cycle yet
    if (!agent) {
      try {
        await refreshAgentRuntimeStatus()
        const refreshedState = getAgentRuntimeStatusState()
        agent = refreshedState.agents.find((a) => a.id === agentId)
        if (!agent) {
          return false
        }
        return agent.isAlive
      } catch (error) {
        console.warn("[AgentRuntimeResolver] Failed to refresh for missing agent:", error)
        return false
      }
    }

    // Return the agent's alive status from the cache
    return agent.isAlive
  }

  /**
   * Check if an agent can be started.
   *
   * Phase 14: Integrated with agent contract API to check if agent profile exists.
   * An agent can be started if:
   * 1. Its profile is registered in the backend (agent-contract-api)
   * 2. The profile is installed and available
   *
   * @param agentId - Agent ID (typically a profile name or agent identifier)
   * @returns Whether agent can be started
   */
  private async canStartAgent(agentId: string): Promise<boolean> {
    try {
      // Query the backend for available agent profiles
      const profiles = await agentContractApi.listProfiles()

      // Check if the agentId matches any registered profile
      // agentId could be a profile name or a runtime-generated ID
      // Use normalizeProviderName to handle case and naming variations
      // (e.g., "claude-code" vs "claude code" vs "Claude-Code")
      const normalizedAgentId = normalizeProviderName(agentId)
      const profileExists = profiles.some(
        (profile) => normalizeProviderName(profile.name) === normalizedAgentId,
      )

      return profileExists
    } catch (error) {
      // If we can't reach the backend, assume agent cannot be started
      // This is a conservative approach to avoid trying to start unavailable agents
      console.warn("[AgentRuntimeResolver] Failed to check agent profiles:", error)
      return false
    }
  }
}

// ============================================================================
// RESOLVER INSTANCE - Singleton
// ============================================================================

/**
 * Global resolver instance.
 */
let resolverInstance: AgentRuntimeResolver | null = null

/**
 * Get the Agent Runtime Resolver instance.
 */
export function getAgentRuntimeResolver(): AgentRuntimeResolver {
  if (!resolverInstance) {
    resolverInstance = new AgentRuntimeResolverImpl()
  }
  return resolverInstance
}

/**
 * Reset the resolver instance (for testing).
 */
export function resetAgentRuntimeResolver(): void {
  resolverInstance = null
}
