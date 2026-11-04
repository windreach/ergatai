/**
 * Helpers for reading and writing ~/.claude.json configuration
 */
import { Mutex } from "async-mutex"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { getRegisteredWorktree } from "./ergatai/user-data"

/**
 * Mutex for protecting read-modify-write operations on ~/.claude.json
 * This prevents race conditions when multiple concurrent operations
 * (e.g., token refreshes for different MCP servers) try to update the config.
 */
const configMutex = new Mutex()

export const CLAUDE_CONFIG_PATH = path.join(os.homedir(), ".claude.json")

export interface McpServerConfig {
  command?: string
  args?: string[]
  url?: string
  authType?: "oauth" | "bearer" | "none"
  _oauth?: {
    accessToken: string
    refreshToken?: string
    clientId?: string
    expiresAt?: number
  }
  [key: string]: unknown
}

export interface ProjectConfig {
  mcpServers?: Record<string, McpServerConfig>
  [key: string]: unknown
}

export interface ClaudeConfig {
  mcpServers?: Record<string, McpServerConfig>  // User-scope (global) MCP servers
  projects?: Record<string, ProjectConfig>
  [key: string]: unknown
}

/**
 * Read ~/.claude.json asynchronously
 * Returns empty config if file doesn't exist or is invalid
 */
export async function readClaudeConfig(): Promise<ClaudeConfig> {
  try {
    const content = await fs.readFile(CLAUDE_CONFIG_PATH, "utf-8")
    return JSON.parse(content)
  } catch {
    return {}
  }
}

/**
 * Write ~/.claude.json asynchronously with atomic write and secure permissions
 */
async function writeClaudeConfig(config: ClaudeConfig): Promise<void> {
  const tempPath = `${CLAUDE_CONFIG_PATH}.tmp.${process.pid}`
  try {
    await fs.writeFile(tempPath, JSON.stringify(config, null, 2), {
      mode: 0o600,
      encoding: "utf-8"
    })
    await fs.rename(tempPath, CLAUDE_CONFIG_PATH)
  } catch (error) {
    try { await fs.unlink(tempPath) } catch { /* ignore */ }
    throw error
  }
}

/**
 * Execute a read-modify-write operation on ~/.claude.json atomically.
 */
export async function updateClaudeConfigAtomic(
  updater: (config: ClaudeConfig) => ClaudeConfig | Promise<ClaudeConfig>
): Promise<ClaudeConfig> {
  return configMutex.runExclusive(async () => {
    const config = await readClaudeConfig()
    const updatedConfig = await updater(config)
    await writeClaudeConfig(updatedConfig)
    return updatedConfig
  })
}

/**
 * Update MCP server config (creates path if needed)
 * Use projectPath = GLOBAL_MCP_PATH (or null) for global MCP servers
 */
export async function updateMcpServerConfig(
  config: ClaudeConfig,
  projectPath: string | null,
  serverName: string,
  update: Partial<McpServerConfig>
): Promise<ClaudeConfig> {
  if (!projectPath || projectPath === GLOBAL_MCP_PATH) {
    config.mcpServers = config.mcpServers || {}
    config.mcpServers[serverName] = {
      ...config.mcpServers[serverName],
      ...update,
    }
    return config
  }
  const resolvedPath = await resolveProjectPathFromWorktree(projectPath) || projectPath
  return config
}

// Special marker for global MCP servers (not tied to a project)
export const GLOBAL_MCP_PATH = "__global__"

/**
 * Remove an MCP server from config
 */
export async function removeMcpServerConfig(
  config: ClaudeConfig,
  projectPath: string | null,
  serverName: string
): Promise<ClaudeConfig> {
  if (!projectPath || projectPath === GLOBAL_MCP_PATH) {
    if (config.mcpServers?.[serverName]) {
      delete config.mcpServers[serverName]
    }
    return config
  }
  return config
}

/**
 * Resolve original project path from a worktree path.
 */
export async function resolveProjectPathFromWorktree(
  pathToResolve: string
): Promise<string | null> {
  const worktreeMarkers = [path.join(".ergatai", "worktrees"), path.join(".21st", "worktrees")]
  const normalizedPath = pathToResolve.replace(/\\/g, "/")
  const matchedMarker = worktreeMarkers.find((marker) =>
    normalizedPath.includes(marker.replace(/\\/g, "/"))
  )

  if (!matchedMarker) {
    return pathToResolve
  }

  try {
    const registered = await getRegisteredWorktree(pathToResolve)
    return registered?.projectPath ?? null
  } catch (error) {
    console.error("[worktree-utils] Failed to resolve project path:", error)
    return null
  }
}

/**
 * Get merged global MCP servers from all user-level sources.
 */
export async function getMergedGlobalMcpServers(): Promise<Record<string, McpServerConfig>> {
  const config = await readClaudeConfig()
  return config.mcpServers || {}
}
