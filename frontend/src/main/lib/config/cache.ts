/**
 * Centralized cache TTL (Time To Live) configurations
 * All values in milliseconds
 */

export const CACHE_TTL = {
  // Network status
  NETWORK_STATUS: 10_000,           // 10 seconds - network connectivity status

  // Worktree
  WORKTREE: 15_000,                 // 15 seconds - worktree registration status

  // GitHub
  GITHUB_STATUS: 10_000,            // 10 seconds - GitHub PR status

  // Plugins
  PLUGINS: 30_000,                  // 30 seconds - plugin list

  // Terminal
  PORT_SCAN: 2_000,                 // 2 seconds - port scan results
  PROCESS_NAME: 10_000,             // 10 seconds - process name lookup

  // Shell environment
  SHELL_ENV: 60_000,                // 1 minute - shell environment variables
  SHELL_ENV_FALLBACK: 10_000,       // 10 seconds - fallback cache on error

  // Files
  FILES_LIST: 60_000,               // 1 minute - file listing

  // Claude settings
  CLAUDE_SETTINGS: 5_000,           // 5 seconds - Claude settings

  // Git cache
  GIT_DIFF: 10_000,                 // 10 seconds - git diff
  GIT_STATUS: 5_000,                // 5 seconds - git status
  GIT_LOG: 30_000,                  // 30 seconds - git log
} as const

export type CacheTTLKey = keyof typeof CACHE_TTL
