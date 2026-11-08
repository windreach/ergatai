import { z } from "zod"
import { router, publicProcedure as procedure } from "../index"

/**
 * Unified discovery endpoint for agent auxiliary information.
 * Aggregates skills, commands, MCP status, and plugins from multiple sources:
 * - Convention files (filesystem scan)
 * - Agent SDK (Claude/OpenCode)
 * - ACP protocol
 * - Runtime state
 */
async function fetchAgentDiscovery(agentId: string, cwd?: string, refresh?: boolean) {
  const url = new URL(
    `/api/v1/agents/${agentId}/discovery`,
    process.env.ERGATAI_API_URL || "http://localhost:3000"
  )
  if (cwd) url.searchParams.set("cwd", cwd)
  if (refresh) url.searchParams.set("refresh", "1")

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
    },
  })

  if (!response.ok) {
    throw new Error(`Discovery failed: ${response.statusText}`)
  }

  const data = await response.json()

  return {
    skills: Array.isArray(data.skills) ? data.skills : [],
    commands: Array.isArray(data.commands) ? data.commands : [],
    mcp: Array.isArray(data.mcp) ? data.mcp : [],
    plugins: Array.isArray(data.plugins) ? data.plugins : [],
    errors: Array.isArray(data.errors) ? data.errors : [],
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
   * Get skills for an agent (convenience wrapper).
   */
  getSkills: procedure
    .input(
      z.object({
        agentId: z.string().min(1),
        cwd: z.string().optional(),
      })
    )
    .query(async ({ input }) => {
      const discovery = await fetchAgentDiscovery(input.agentId, input.cwd)
      return discovery.skills
    }),

  /**
   * Get commands for an agent (convenience wrapper).
   */
  getCommands: procedure
    .input(
      z.object({
        agentId: z.string().min(1),
        cwd: z.string().optional(),
      })
    )
    .query(async ({ input }) => {
      const discovery = await fetchAgentDiscovery(input.agentId, input.cwd)
      return discovery.commands
    }),

  /**
   * Get MCP status for an agent (convenience wrapper).
   */
  getMcpStatus: procedure
    .input(
      z.object({
        agentId: z.string().min(1),
        cwd: z.string().optional(),
      })
    )
    .query(async ({ input }) => {
      const discovery = await fetchAgentDiscovery(input.agentId, input.cwd)
      return discovery.mcp
    }),

  /**
   * Get plugins (Claude marketplace scan).
   * Plugins are global, not agent-specific.
   */
  getPlugins: procedure.query(async () => {
    // Plugins are global, not agent-specific.
    const response = await fetch(
      `${process.env.ERGATAI_API_URL || "http://localhost:3000"}/api/v1/plugins`,
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
        },
      }
    )

    if (!response.ok) {
      // Fallback to empty if backend fails
      return []
    }

    const data = await response.json()
    return Array.isArray(data.plugins) ? data.plugins : []
  }),
})
