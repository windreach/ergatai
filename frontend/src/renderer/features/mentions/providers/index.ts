/**
 * Mention Providers
 *
 * This module exports all built-in mention providers and provides
 * utilities for registering them with the mention registry.
 */

export { filesProvider, type FileData } from "./files-provider"
export { skillsProvider, type SkillData, type SkillsSearchContext } from "./skills-provider"
export { agentsProvider, type AgentData, type AgentModel } from "./agents-provider"
export { toolsProvider, type ToolData, type ToolsSearchContext } from "./tools-provider"
export { commandsProvider, type CommandData, type CommandsSearchContext } from "./commands-provider"

// Re-export types
export type { MentionProvider } from "../types"

import { filesProvider } from "./files-provider"
import { skillsProvider } from "./skills-provider"
import { agentsProvider } from "./agents-provider"
import { toolsProvider } from "./tools-provider"
import { commandsProvider } from "./commands-provider"
import { mentionRegistry } from "../registry"
import type { MentionProvider } from "../types"

/**
 * All built-in providers
 */
export const builtInProviders: MentionProvider[] = [
  filesProvider,
  skillsProvider,
  agentsProvider,
  toolsProvider,
  commandsProvider,
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
