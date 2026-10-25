/**
 * Conversation Resolver
 *
 * Resolves conversation context from invocation input. This resolver is responsible
 * for:
 * - Determining conversation mode (normal, group, agent)
 * - Resolving backend conversation ID
 * - Determining provider type
 * - Resolving workspace context
 *
 * Phase 4: Initial implementation.
 * This resolver will be used by ConversationInvocationService to resolve conversation context.
 */

import type {
  ConversationInvocationSource,
  ResolvedConversation,
  ConversationSource,
} from "./contracts"

// ============================================================================
// RESOLVER INTERFACE - Public API
// ============================================================================

/**
 * Conversation Resolver interface.
 */
export interface ConversationResolver {
  /**
   * Resolve conversation context from invocation input.
   *
   * @param input - Invocation source
   * @returns Resolved conversation
   */
  resolve(input: ConversationInvocationSource): Promise<ResolvedConversation>
}

// ============================================================================
// RESOLVER IMPLEMENTATION
// ============================================================================

/**
 * Conversation Resolver implementation.
 *
 * Phase 4: Simplified implementation that extracts conversation context
 * from the input. Future versions may query backend for additional context.
 */
class ConversationResolverImpl implements ConversationResolver {
  /**
   * Resolve conversation context.
   *
   * @param input - Invocation source
   * @returns Resolved conversation
   */
  async resolve(input: ConversationInvocationSource): Promise<ResolvedConversation> {
    const {
      chatId,
      conversationId,
      backendConversationId,
      agentId,
      provider,
      source,
    } = input

    // Determine conversation mode
    const mode = this.determineConversationMode(input)

    // Resolve backend conversation ID
    const resolvedBackendConversationId = backendConversationId ?? conversationId

    // Resolve provider
    const resolvedProvider = provider ?? "claude-code"

    // Build resolved conversation
    const resolved: ResolvedConversation = {
      conversationId,
      backendConversationId: resolvedBackendConversationId,
      chatId,
      agentId: agentId ?? null,
      provider: resolvedProvider,
      mode,
      source,
    }

    return resolved
  }

  /**
   * Determine conversation mode from invocation source.
   *
   * @param input - Invocation source
   * @returns Conversation mode
   */
  private determineConversationMode(input: ConversationInvocationSource): "normal" | "group" | "agent" {
    const { source, agentId } = input

    // Group chat mode
    if (source === "group") {
      return "group"
    }

    // Agent-specific mode
    if (agentId) {
      return "agent"
    }

    // Default: normal mode
    return "normal"
  }
}

// ============================================================================
// RESOLVER INSTANCE - Singleton
// ============================================================================

/**
 * Global resolver instance.
 */
let resolverInstance: ConversationResolver | null = null

/**
 * Get the Conversation Resolver instance.
 */
export function getConversationResolver(): ConversationResolver {
  if (!resolverInstance) {
    resolverInstance = new ConversationResolverImpl()
  }
  return resolverInstance
}

/**
 * Reset the resolver instance (for testing).
 */
export function resetConversationResolver(): void {
  resolverInstance = null
}
