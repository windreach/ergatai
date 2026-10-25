/**
 * Transport Resolver
 *
 * Resolves the appropriate chat transport based on conversation context and
 * agent runtime. This resolver is responsible for:
 * - Selecting the correct transport type (ErgataiChatTransport, GroupChatTransport, etc.)
 * - Configuring transport with workspace, command, and other options
 * - Handling transport overrides
 *
 * Phase 13: Integrated actual transport implementations.
 * - Normal mode → ErgataiChatTransport (user-to-agent chat)
 * - Agent mode → ErgataiChatTransport (agent-to-agent communication)
 * - Group mode → GroupChatTransport (multi-agent group chat)
 *
 * This replaces the Phase 6 mock transports with production-ready implementations.
 */

import type {
  ResolvedConversation,
  ResolvedAgentRuntime,
  ConversationSendMessageInput,
} from "./contracts"

import {
  ErgataiChatTransport,
  createUserChatTransport,
  createAgentToAgentTransport,
} from "../../agents/lib/ergatai-chat-transport"

import { GroupChatTransport } from "../../agents/lib/group-chat-transport"

// ============================================================================
// TRANSPORT TYPES - Re-export actual transport interface
// ============================================================================

/**
 * Chat transport interface.
 * This matches the ChatTransport interface from "ai" SDK.
 * All transports implement this interface.
 */
export interface ChatTransport {
  /** Send messages and get a streaming response */
  sendMessages(options: {
    messages: any[]
    abortSignal?: AbortSignal
  }): Promise<ReadableStream<any>>

  /** Reconnect to an existing stream (if supported) */
  reconnectToStream(): Promise<ReadableStream<any> | null>

  /** Clean up transport resources */
  cleanup?(): void
}

// ============================================================================
// RESOLVER CONTEXT - Input for transport resolution
// ============================================================================

/**
 * Context for transport resolution.
 */
export type TransportResolverContext = {
  /** Resolved conversation */
  conversation: ResolvedConversation

  /** Resolved agent runtime */
  runtime: ResolvedAgentRuntime

  /** Transport overrides from send input */
  overrides?: ConversationSendMessageInput["transportOverrides"]
}

// ============================================================================
// RESOLVER INTERFACE - Public API
// ============================================================================

/**
 * Transport Resolver interface.
 */
export interface TransportResolver {
  /**
   * Resolve the appropriate transport for the given context.
   *
   * @param context - Resolver context
   * @returns Chat transport
   */
  resolve(context: TransportResolverContext): ChatTransport
}

// ============================================================================
// RESOLVER IMPLEMENTATION
// ============================================================================

/**
 * Transport Resolver implementation.
 *
 * Phase 13: Creates actual transport instances based on conversation mode.
 * - Normal/Agent modes use ErgataiChatTransport with appropriate configuration
 * - Group mode uses GroupChatTransport
 */
class TransportResolverImpl implements TransportResolver {
  /**
   * Resolve transport.
   *
   * @param context - Resolver context
   * @returns Chat transport
   */
  resolve(context: TransportResolverContext): ChatTransport {
    const { conversation, runtime, overrides } = context

    // Determine transport type based on conversation mode
    const transportType = this.determineTransportType(conversation, overrides)

    // Create transport based on type
    switch (transportType) {
      case "group":
        return this.createGroupTransport(conversation, overrides)
      case "agent":
        return this.createAgentTransport(conversation, runtime, overrides)
      case "normal":
      default:
        return this.createNormalTransport(conversation, overrides)
    }
  }

  /**
   * Determine transport type from conversation and overrides.
   *
   * @param conversation - Resolved conversation
   * @param overrides - Transport overrides
   * @returns Transport type
   */
  private determineTransportType(
    conversation: ResolvedConversation,
    overrides?: ConversationSendMessageInput["transportOverrides"],
  ): "normal" | "group" | "agent" {
    // Use override if provided
    if (overrides?.mode) {
      return overrides.mode
    }

    // Use conversation mode
    return conversation.mode
  }

  /**
   * Create a normal transport for user-to-agent communication.
   *
   * Phase 13: Creates ErgataiChatTransport for standard chat.
   * This is the primary transport for user interactions with a single agent.
   *
   * @param conversation - Resolved conversation
   * @param overrides - Transport overrides
   * @returns Chat transport
   */
  private createNormalTransport(
    conversation: ResolvedConversation,
    overrides?: ConversationSendMessageInput["transportOverrides"],
  ): ChatTransport {
    // Map conversation mode to ErgataiChatTransport mode
    // "normal" maps to "agent" mode in the transport (default behavior)
    const transportMode = "agent"

    return createUserChatTransport(
      conversation.chatId,
      conversation.backendConversationId ?? conversation.conversationId,
      {
        agentId: conversation.agentId ?? undefined,
        command: overrides?.command,
        mode: transportMode,
      },
    )
  }

  /**
   * Create a group transport for multi-agent communication.
   *
   * Phase 13: Creates GroupChatTransport for group chat scenarios.
   * GroupChatTransport is currently a stub - full implementation pending.
   *
   * @param conversation - Resolved conversation
   * @param overrides - Transport overrides
   * @returns Chat transport
   */
  private createGroupTransport(
    conversation: ResolvedConversation,
    overrides?: ConversationSendMessageInput["transportOverrides"],
  ): ChatTransport {
    // GroupChatTransport doesn't require configuration yet
    // Future: Pass workspace/conversation context when group chat is fully implemented
    return new GroupChatTransport()
  }

  /**
   * Create an agent transport for agent-to-agent communication.
   *
   * Phase 13: Creates ErgataiChatTransport with agent-to-agent configuration.
   * This enables agents to send messages to other agents through the chat interface.
   *
   * @param conversation - Resolved conversation
   * @param runtime - Resolved agent runtime
   * @param overrides - Transport overrides
   * @returns Chat transport
   */
  private createAgentTransport(
    conversation: ResolvedConversation,
    runtime: ResolvedAgentRuntime,
    overrides?: ConversationSendMessageInput["transportOverrides"],
  ): ChatTransport {
    // Agent-to-agent communication requires fromAgentId
    const fromAgentId = runtime.fromAgentId ?? undefined

    if (!fromAgentId) {
      // Fallback to normal transport if no fromAgentId
      // This shouldn't happen in practice, but provides graceful degradation
      console.warn(
        "[TransportResolver] Agent mode requested without fromAgentId, falling back to normal transport",
      )
      return this.createNormalTransport(conversation, overrides)
    }

    return createAgentToAgentTransport(
      conversation.chatId,
      conversation.backendConversationId ?? conversation.conversationId,
      fromAgentId,
      {
        targetAgentCommand: runtime.targetAgentId ?? undefined,
        forceNewSession: overrides?.forceNewSession,
        correlationId: overrides?.correlationId,
        mode: "agent",
      },
    )
  }
}

// ============================================================================
// RESOLVER INSTANCE - Singleton
// ============================================================================

/**
 * Global resolver instance.
 */
let resolverInstance: TransportResolver | null = null

/**
 * Get the Transport Resolver instance.
 */
export function getTransportResolver(): TransportResolver {
  if (!resolverInstance) {
    resolverInstance = new TransportResolverImpl()
  }
  return resolverInstance
}

/**
 * Reset the resolver instance (for testing).
 */
export function resetTransportResolver(): void {
  resolverInstance = null
}
