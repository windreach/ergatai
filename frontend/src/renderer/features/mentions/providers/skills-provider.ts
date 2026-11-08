/**
 * Skills Mention Provider
 *
 * Uses the unified discovery endpoint to provide skill search.
 * Supports both convention-based skills and agent SDK skills.
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
 * Data payload for skill mentions
 */
export interface SkillData {
  name: string
  description: string
  source: "user" | "project" | "plugin" | "agent-sdk" | "convention"
  path: string
}

/**
 * Extended search context with optional agent ID
 */
export interface SkillsSearchContext extends MentionSearchContext {
  /**
   * Agent ID for agent-specific skills discovery
   * If not provided, only convention-based skills are returned
   */
  agentId?: string
}

/**
 * Skills provider
 */
// Simple in-memory cache for discovery results (30s TTL).
const SKILLS_CACHE_TTL = 30_000
const SKILLS_CACHE_MAX_ENTRIES = 50
const skillsCache = new Map<string, { data: Array<{ name: string; description: string; path: string; source: string }>; expires: number }>()

function skillsCacheKey(agentId: string | undefined, cwd: string | undefined): string {
  return `${agentId ?? ""}::${cwd ?? ""}`
}

function evictExpiredSkillsCache(now: number) {
  for (const [key, entry] of skillsCache) {
    if (entry.expires <= now) skillsCache.delete(key)
  }
}

function setSkillsCache(key: string, data: Array<{ name: string; description: string; path: string; source: string }>) {
  evictExpiredSkillsCache(Date.now())
  if (skillsCache.size >= SKILLS_CACHE_MAX_ENTRIES) {
    const oldest = skillsCache.keys().next().value
    if (oldest) skillsCache.delete(oldest)
  }
  skillsCache.set(key, { data, expires: Date.now() + SKILLS_CACHE_TTL })
}

export const skillsProvider = createMentionProvider<SkillData>({
  id: "skills",
  name: "Skills",
  category: {
    label: "Skills",
    priority: 80,
  },
  trigger: {
    char: "@",
    position: "standalone",
    allowSpaces: true,
  },
  priority: 80,

  async search(context: MentionSearchContext): Promise<MentionSearchResult<SkillData>> {
    const startTime = performance.now()

    // Check for abort
    if (context.signal.aborted) {
      return { items: [], hasMore: false, timing: 0 }
    }

    try {
      // Try to use unified discovery endpoint if agentId is available
      const skillsContext = context as SkillsSearchContext
      let skills: Array<{
        name: string
        description: string
        path: string
        source: string
      }>

      if (skillsContext.agentId) {
        // Use discovery endpoint for agent-specific skills
        const key = skillsCacheKey(skillsContext.agentId, context.projectPath)
        evictExpiredSkillsCache(Date.now())
        const cached = skillsCache.get(key)
        if (cached && cached.expires > Date.now()) {
          // Mark as recently used for LRU eviction.
          skillsCache.delete(key)
          skillsCache.set(key, cached)
          skills = cached.data
        } else {
          const discovery = await trpcClient.discovery.getSkills.query({
            agentId: skillsContext.agentId,
            cwd: context.projectPath,
          })
          skills = discovery
          setSkillsCache(key, discovery)
        }
      } else {
        // Fallback to convention-based skills only
        skills = await trpcClient.skills.listEnabled.query({
          cwd: context.projectPath,
        })
      }

      // Map to MentionItem format
      let items: MentionItem<SkillData>[] = skills.map((skill) => ({
        id: `${MENTION_PREFIXES.SKILL}${skill.name}`,
        label: skill.name,
        description: skill.description || skill.path,
        icon: "skill",
        data: {
          name: skill.name,
          description: skill.description,
          source: (skill.source || "convention") as SkillData["source"],
          path: skill.path,
        },
        // Project skills have higher priority, SDK skills even higher
        priority: skill.source === "agent-sdk" ? 20 : skill.source === "project" ? 10 : 0,
        metadata: {
          type: "skill" as const,
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
        totalCount: skills.length,
        timing,
      }
    } catch (error) {
      console.error("[SkillsProvider] Search error:", error)
      return {
        items: [],
        hasMore: false,
        warning: "Failed to load skills",
        timing: performance.now() - startTime,
      }
    }
  },

  serialize(item: MentionItem<SkillData>): string {
    return buildGenericMentionToken(item.id)
  },

  deserialize(token: string): MentionItem<SkillData> | null {
    try {
      // Check if this token belongs to us
      if (!token.startsWith(MENTION_PREFIXES.SKILL)) {
        return null
      }

      // Parse: skill:name
      const name = token.slice(MENTION_PREFIXES.SKILL.length)

      if (!name) {
        return null
      }

      return {
        id: token,
        label: name,
        description: "", // Will be resolved later if needed
        icon: "skill",
        data: {
          name,
          description: "",
          source: "user", // Default, will be resolved
          path: "",
        },
        metadata: {
          type: "skill",
        },
      }
    } catch (error) {
      console.warn(`[SkillsProvider] Failed to deserialize token: ${token}`, error)
      return null
    }
  },

  // Skills are always available
  isAvailable() {
    return true
  },
})

export default skillsProvider
