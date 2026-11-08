/**
 * Mention Providers
 *
 * This module exports built-in mention providers and provides
 * utilities for registering them with the mention registry.
 *
 * NOTE: Only files and agents providers are retained. Skills/commands/MCP
 * mention providers were removed as part of the group unification cleanup.
 */

export { filesProvider, type FileData } from "./files-provider"
export { agentsProvider, type AgentData, type AgentModel } from "./agents-provider"

// Re-export types
export type { MentionProvider } from "../types"

import { filesProvider } from "./files-provider"
import { agentsProvider } from "./agents-provider"
import { mentionRegistry } from "../registry"
import type { MentionProvider } from "../types"

/**
 * All built-in providers
 */
export const builtInProviders: MentionProvider[] = [
  filesProvider,
  agentsProvider,
]

/**
 * Register all built-in providers with the registry
 * Returns an unregister function
 */
export function registerBuiltInProviders(): () => void {
  return mentionRegistry.registerAll(builtInProviders)
}

/**
 * Register a single provider
 */
export function registerProvider(provider: MentionProvider): () => void {
  return mentionRegistry.register(provider)
}