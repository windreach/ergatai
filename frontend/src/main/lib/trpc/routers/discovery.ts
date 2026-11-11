import { z } from "zod"
import { router, publicProcedure as procedure } from "../index"
import { ergataiFetch } from "../../ergatai/api"

/**
 * Unified discovery endpoint for agent auxiliary information.
 * Aggregates skills, commands, MCP status, and plugins from multiple sources:
 * - Convention files (filesystem scan)
 * - Agent SDK (Claude/OpenCode)
 * - ACP protocol
 * - Runtime state
 */
async function fetchAgentDiscovery(agentId: string, cwd?: string, refresh?: boolean) {
  const params = new URLSearchParams()
  if (cwd) params.set("cwd", cwd)
  if (refresh) params.set("refresh", "1")
  const query = params.toString()
  const path = `/api/v1/agents/${agentId}/discovery${query ? `?${query}` : ""}`

  const data = await ergataiFetch<Record<string, unknown>>(path, {
    method: "GET",
  })

  return {
    skills: Array.isArray(data.skills) ? data.skills : [],
    commands: Array.isArray(data.commands) ? data.commands : [],
    mcp: Array.isArray(data.mcp) ? data.mcp : [],
    plugins: Array.isArray(data.plugins) ? data.plugins : [],
    errors: Array.isArray(data.errors) ? data.errors : [],
    triggers: Array.isArray(data.triggers) ? data.triggers : [],
  }
}

/**
 * Static discovery: filesystem-based sources only (convention_skills + plugins).
 * Does not require an agent_id — usable in new-chat / no-agent scenarios.
 */
async function fetchStaticDiscovery(cwd?: string, refresh?: boolean, agent?: string) {
  const params = new URLSearchParams()
  if (cwd) params.set("cwd", cwd)
  if (agent) params.set("agent", agent)
  if (refresh) params.set("refresh", "1")
  const query = params.toString()
  const path = `/api/v1/discovery/static${query ? `?${query}` : ""}`

  const data = await ergataiFetch<Record<string, unknown>>(path, {
    method: "GET",
  })

  return {
    skills: Array.isArray(data.skills) ? data.skills : [],
    plugins: Array.isArray(data.plugins) ? data.plugins : [],
    triggers: Array.isArray(data.triggers) ? data.triggers : [],
  }
}

/**
 * Trigger registry: returns editor trigger config (/, @, etc.).
 * Independent of discovery — frontend can cache trigger config separately.
 */
async function fetchTriggers(agentId?: string, cwd?: string) {
  const params = new URLSearchParams()
  if (cwd) params.set("cwd", cwd)
  if (agentId) params.set("agent_id", agentId)
  const query = params.toString()
  const path = `/api/v1/triggers${query ? `?${query}` : ""}`

  const data = await ergataiFetch<Record<string, unknown>>(path, {
    method: "GET",
  })

  return {
    triggers: Array.isArray(data.triggers) ? data.triggers : [],
  }
}

export const discoveryRouter = router({
  /**
   * Get all auxiliary information for an agent.
   * Frontend calls this when user types @ or / in input.
   */
  getAgentDiscovery: procedure
    .input(
      z.object({
        agentId: z.string().min(1),
        cwd: z.string().optional(),
        refresh: z.boolean().optional(),
      })
    )
    .query(async ({ input }) => {
      return fetchAgentDiscovery(input.agentId, input.cwd, input.refresh)
    }),

  /**
   * Static discovery: convention_skills + plugins.
   * No agent_id required — works in new-chat / no-agent scenarios.
   */
  getStaticDiscovery: procedure
    .input(
      z.object({
        cwd: z.string().optional(),
        refresh: z.boolean().optional(),
        agent: z.string().optional(),
      })
    )
    .query(async ({ input }) => {
      return fetchStaticDiscovery(input.cwd, input.refresh, input.agent)
    }),

  /**
   * Trigger registry: returns editor trigger config.
   * Independent of discovery — can be cached with longer TTL.
   */
  getTriggers: procedure
    .input(
      z.object({
        agentId: z.string().optional(),
        cwd: z.string().optional(),
      })
    )
    .query(async ({ input }) => {
      return fetchTriggers(input.agentId, input.cwd)
    }),

  // Convenience wrappers removed; use getAgentDiscovery for all auxiliary data.
})
