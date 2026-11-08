/**
 * Commands Mention Provider
 *
 * Provides slash commands for mentions using the unified discovery endpoint.
 * Supports both ACP commands and agent SDK commands.
 */

import { trpcClient } from "../../../lib/trpc"
import {
  createMentionProvider,
  type MentionItem,
  type MentionSearchContext,
  type MentionSearchResult,
  MENTION_PREFIXES,
  sortByRelevance,
} from "../types"
import { buildGenericMentionToken } from "../../agents"

/**
 * Data payload for command mentions
 */
export interface CommandData {
  name: string
  description: string
  argumentHint: string
  aliases: string[]
  source: "acp" | "agent-sdk"
}

/**
 * Extended search context with optional agent ID
 */
export interface CommandsSearchContext extends MentionSearchContext {
  /**
   * Agent ID for agent-specific commands discovery
   * If not provided, only ACP commands are returned
   */
  agentId?: string
}

/**
 * Commands provider
 */
// Simple in-memory cache for discovery results (30s TTL).
const COMMANDS_CACHE_TTL = 30_000
const COMMANDS_CACHE_MAX_ENTRIES = 50
const commandsCache = new Map<string, { data: Array<{ name: string; description: string; argumentHint?: string; aliases?: string[]; source?: string }>; expires: number }>()

function commandsCacheKey(agentId: string | undefined, cwd: string | undefined): string {
  return `${agentId ?? ""}::${cwd ?? ""}`
}

function setCommandsCache(key: string, data: Array<{ name: string; description: string; argumentHint?: string; aliases?: string[]; source?: string }>) {
  const now = Date.now()
  for (const [k, entry] of commandsCache) {
    if (entry.expires <= now) commandsCache.delete(k)
  }
  if (commandsCache.size >= COMMANDS_CACHE_MAX_ENTRIES) {
    const oldest = commandsCache.keys().next().value
    if (oldest) commandsCache.delete(oldest)
  }
  commandsCache.set(key, { data, expires: now + COMMANDS_CACHE_TTL })
}

export const commandsProvider = createMentionProvider<CommandData>({
  id: "commands",
  name: "Commands",
  category: {
    label: "Commands",
    priority: 90,
  },
  trigger: {
    char: "/",
    position: "start-of-line",
    allowSpaces: false,
  },
  priority: 90,

  async search(context: MentionSearchContext): Promise<MentionSearchResult<CommandData>> {
    const startTime = performance.now()

    // Check for abort
    if (context.signal.aborted) {
      return { items: [], hasMore: false, timing: 0 }
    }

    try {
      // Try to use unified discovery endpoint if agentId is available
      const commandsContext = context as CommandsSearchContext
      let commands: Array<{
        name: string
        description: string
        argumentHint?: string
        aliases?: string[]
        source?: string
      }>

      if (commandsContext.agentId) {
        // Use discovery endpoint for agent-specific commands
        const key = commandsCacheKey(commandsContext.agentId, context.projectPath)
        const now = Date.now()
        for (const [k, entry] of commandsCache) {
          if (entry.expires <= now) commandsCache.delete(k)
        }
        const cached = commandsCache.get(key)
        if (cached && cached.expires > Date.now()) {
          // Mark as recently used for LRU eviction.
          commandsCache.delete(key)
          commandsCache.set(key, cached)
          commands = cached.data
        } else {
          const discovery = await trpcClient.discovery.getCommands.query({
            agentId: commandsContext.agentId,
            cwd: context.projectPath,
          })
          commands = discovery
          setCommandsCache(key, discovery)
        }
      } else {
        // No agent context: cannot discover commands.
        return {
          items: [],
          hasMore: false,
          warning: "Select an agent to discover commands",
          timing: performance.now() - startTime,
        }
      }

      // Map to MentionItem format
      let items: MentionItem<CommandData>[] = commands.map((cmd) => ({
        id: `${MENTION_PREFIXES.COMMAND}${cmd.name}`,
        label: `/${cmd.name}`,
        description: cmd.description || "",
        icon: "command",
        data: {
          name: cmd.name,
          description: cmd.description || "",
          argumentHint: cmd.argumentHint || "",
          aliases: cmd.aliases || [],
          source: (cmd.source || "acp") as CommandData["source"],
        },
        // SDK commands have slightly higher priority
        priority: cmd.source === "agent-sdk" ? 10 : 0,
        keywords: [cmd.name, ...(cmd.aliases || [])],
        metadata: {
          type: "command" as const,
        },
      }))

      // Apply relevance sorting if there's a query
      if (context.query) {
        items = sortByRelevance(items, context.query)
      }

      // Apply limit
      const limitedItems = items.slice(0, context.limit)

      const timing = performance.now() - startTime

      return {
        items: limitedItems,
        hasMore: items.length > context.limit,
        totalCount: commands.length,
        timing,
      }
    } catch (error) {
      console.error("[CommandsProvider] Search error:", error)
      return {
        items: [],
        hasMore: false,
        warning: "Failed to load commands",
        timing: performance.now() - startTime,
      }
    }
  },

  serialize(item: MentionItem<CommandData>): string {
    return buildGenericMentionToken(item.id)
  },

  deserialize(token: string): MentionItem<CommandData> | null {
    try {
      // Check if this token belongs to us
      if (!token.startsWith(MENTION_PREFIXES.COMMAND)) {
        return null
      }

      // Parse: command:name
      const name = token.slice(MENTION_PREFIXES.COMMAND.length)

      if (!name) {
        return null
      }

      return {
        id: token,
        label: `/${name}`,
        description: "",
        icon: "command",
        data: {
          name,
          description: "",
          argumentHint: "",
          aliases: [],
          source: "acp",
        },
        metadata: {
          type: "command",
        },
      }
    } catch (error) {
      console.warn(`[CommandsProvider] Failed to deserialize token: ${token}`, error)
      return null
    }
  },

  // Commands are always available (even if empty)
  isAvailable() {
    return true
  },
})

export default commandsProvider
