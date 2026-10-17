import { z } from "zod"
import { publicProcedure, router } from "../index"
import {
  readClaudeConfig,
  updateClaudeConfigAtomic,
  updateMcpServerConfig,
  removeMcpServerConfig,
  getMergedGlobalMcpServers,
  GLOBAL_MCP_PATH,
  type McpServerConfig,
} from "../../claude-config"
import {
  fetchMcpTools,
  fetchMcpToolsStdio,
} from "../../mcp-tools"
import { ergataiFetch } from "../../ergatai/api"
import { getClaudeShellEnvironment } from "../../claude/env"

// ── Session tracking (for hasActive/abortAll exports) ──────────────────

const activeSessions = new Set<string>()

export function hasActiveClaudeSessions(): boolean {
  return activeSessions.size > 0
}

export function abortAllClaudeSessions(): void {
  activeSessions.clear()
}

export function clearClaudeCaches(): void {
  // Invalidate any cached MCP config
}

// ── Helpers ─────────────────────────────────────────────────────────────

type McpServerEntry = McpServerConfig & {
  name: string
  status: string
  tools: Array<{ name: string; description?: string }>
  error?: string
  needsAuth: boolean
  config: Record<string, unknown>
  serverInfo?: { name: string; version: string }
}

async function buildMcpGroups(): Promise<
  Array<{ groupName: string; projectPath: string | null; mcpServers: McpServerEntry[] }>
> {
  const globalServers = await getMergedGlobalMcpServers()
  const config = await readClaudeConfig()

  const groups: Array<{ groupName: string; projectPath: string | null; mcpServers: McpServerEntry[] }> = []

  // Global group
  const globalEntries: McpServerEntry[] = Object.entries(globalServers).map(([name, cfg]) => ({
    ...cfg,
    name,
    status: cfg.command || cfg.url ? "connected" : "pending",
    tools: [],
    needsAuth: cfg.authType === "oauth",
    config: cfg as Record<string, unknown>,
  }))
  if (globalEntries.length > 0) {
    groups.push({ groupName: "Global", projectPath: null, mcpServers: globalEntries })
  }

  // Project-specific groups
  for (const [projectPath, projectConfig] of Object.entries(config.projects ?? {})) {
    const servers = projectConfig.mcpServers ?? {}
    const entries: McpServerEntry[] = Object.entries(servers).map(([name, cfg]) => ({
      ...cfg,
      name,
      status: cfg.command || cfg.url ? "connected" : "pending",
      tools: [],
      needsAuth: cfg.authType === "oauth",
      config: cfg as Record<string, unknown>,
    }))
    if (entries.length > 0) {
      groups.push({ groupName: projectPath.split("/").pop() || projectPath, projectPath, mcpServers: entries })
    }
  }

  return groups
}

function resolveMcpProjectPath(
  scope: "global" | "project",
  projectPath: string | null | undefined,
): string {
  if (scope === "project") {
    if (!projectPath?.trim()) {
      throw new Error("projectPath is required for project-scoped MCP servers")
    }
    return projectPath
  }
  return GLOBAL_MCP_PATH
}

function toMcpServerEntries(servers: Record<string, McpServerConfig>) {
  return Object.entries(servers).map(([name, cfg]) => ({
    ...cfg,
    name,
    status: cfg.command || cfg.url ? "connected" : "pending",
    tools: [],
    needsAuth: cfg.authType === "oauth",
    config: cfg as Record<string, unknown>,
  }))
}

export const claudeRouter = router({
  /** Get all MCP servers grouped by scope - file reading removed, returns empty */
  getAllMcpConfig: publicProcedure.query(async (): Promise<{
    groups: Array<{ groupName: string; projectPath: string | null; mcpServers: McpServerEntry[] }>
  }> => {
    return { groups: [] }
  }),

  /** Get MCP config for a specific project (or global) - file reading removed, returns empty */
  getMcpConfig: publicProcedure
    .input(z.object({ projectPath: z.string().nullish() }).optional())
    .query(async (): Promise<{ mcpServers: McpServerEntry[] }> => {
      return { mcpServers: [] }
    }),

  /** Add a new MCP server */
  addMcpServer: publicProcedure
    .input(
      z.object({
        name: z.string().min(1),
        scope: z.enum(["global", "project"]).default("global"),
        transport: z.enum(["stdio", "http"]),
        command: z.string().optional(),
        args: z.array(z.string()).optional(),
        url: z.string().optional(),
        projectPath: z.string().nullish(),
      }),
    )
    .mutation(async ({ input }) => {
      const projectPath = resolveMcpProjectPath(input.scope, input.projectPath)
      const serverConfig: Partial<McpServerConfig> = {}
      if (input.transport === "http") {
        serverConfig.url = input.url
      } else {
        serverConfig.command = input.command
        serverConfig.args = input.args
      }
      await updateClaudeConfigAtomic(async (config) =>
        updateMcpServerConfig(config, projectPath ?? GLOBAL_MCP_PATH, input.name, serverConfig),
      )
      return { success: true }
    }),

  /** Update an existing MCP server */
  updateMcpServer: publicProcedure
    .input(
      z.object({
        name: z.string().min(1),
        scope: z.enum(["global", "project"]).default("global"),
        projectPath: z.string().nullish(),
        disabled: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const projectPath = resolveMcpProjectPath(input.scope, input.projectPath)
      await updateClaudeConfigAtomic(async (config) =>
        updateMcpServerConfig(config, projectPath ?? GLOBAL_MCP_PATH, input.name, {
          disabled: input.disabled,
        }),
      )
      return { success: true }
    }),

  /** Remove an MCP server */
  removeMcpServer: publicProcedure
    .input(
      z.object({
        name: z.string().min(1),
        scope: z.enum(["global", "project"]).default("global"),
        projectPath: z.string().nullish(),
      }),
    )
    .mutation(async ({ input }) => {
      const projectPath = resolveMcpProjectPath(input.scope, input.projectPath)
      await updateClaudeConfigAtomic(async (config) =>
        removeMcpServerConfig(config, projectPath ?? GLOBAL_MCP_PATH, input.name),
      )
      return { success: true }
    }),

  /** Set bearer token for an MCP server */
  setMcpBearerToken: publicProcedure
    .input(
      z.object({
        name: z.string().min(1),
        scope: z.enum(["global", "project"]).default("global"),
        token: z.string(),
        projectPath: z.string().nullish(),
      }),
    )
    .mutation(async ({ input }) => {
      const projectPath = resolveMcpProjectPath(input.scope, input.projectPath)
      await updateClaudeConfigAtomic(async (config) =>
        updateMcpServerConfig(config, projectPath ?? GLOBAL_MCP_PATH, input.name, {
          authType: "bearer",
          headers: {
            Authorization: `Bearer ${input.token}`,
          },
        }),
      )
      return { success: true }
    }),

  /** Refresh MCP server config (re-fetch tools) */
  refreshMcpConfig: publicProcedure.mutation(async () => {
    const servers = await getMergedGlobalMcpServers()
    const shellEnv = getClaudeShellEnvironment()

    return Object.fromEntries(
      await Promise.all(
        Object.entries(servers).map(async ([name, config]) => {
          try {
            if (config.url) {
              const tools = await fetchMcpTools(config.url)
              return [name, { status: tools.length > 0 ? "connected" : "pending", tools }] as const
            }

            if (config.command) {
              const tools = await fetchMcpToolsStdio({
                command: config.command,
                args: config.args ?? [],
                env: shellEnv as Record<string, string> | undefined,
              })
              return [name, { status: tools.length > 0 ? "connected" : "pending", tools }] as const
            }

            return [name, { status: "pending" }] as const
          } catch (err) {
            return [
              name,
              {
                status: "failed",
                error: err instanceof Error ? err.message : String(err),
              },
            ] as const
          }
        }),
      ),
    )
  }),

  /** Start OAuth flow for an MCP server (not supported - stub) */
  startMcpOAuth: publicProcedure
    .input(
      z.object({
        serverName: z.string().min(1),
        projectPath: z.string().nullish(),
      }),
    )
    .mutation(async ({ input }) => {
      // OAuth flow removed in v1.0 - MCP servers should be configured externally
      return {
        success: false,
        error: `MCP OAuth not supported. Configure ${input.serverName} credentials externally.`,
      }
    }),

  /** Respond to a tool approval request (e.g. plan approval, question answering) */
  respondToolApproval: publicProcedure
    .input(
      z.object({
        toolUseId: z.string(),
        approved: z.boolean(),
        message: z.string().optional(),
        updatedInput: z.record(z.any()).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      // Respond through the unified permission request feed. Elicitation
      // requests (plan approvals, AskUserQuestion) are resolved by the
      // backend's /respond endpoint, which forwards to the right agent.
      await ergataiFetch(
        `/api/v1/permissions/${encodeURIComponent(input.toolUseId)}/respond`,
        {
          method: "POST",
          body: JSON.stringify({
            decision: input.approved ? "allow_once" : "reject_once",
            form_data: input.updatedInput ??
              (input.message ? { message: input.message } : undefined),
          }),
        },
      )

      return { success: true, toolUseId: input.toolUseId, approved: input.approved }
    }),
})
