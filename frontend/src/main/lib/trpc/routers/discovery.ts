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

  // Convenience wrappers removed; use getAgentDiscovery for all auxiliary data.
})
