/**
 * Terminal utility functions.
 */
import { debounce } from "es-toolkit"

export { debounce }

/**
 * Compute the terminal scope key for a chat/workspace.
 * - Local mode (no branch): shared across all local workspaces on the same project path
 * - Worktree mode (has branch): isolated per workspace
 */
export function getTerminalScopeKey(chat: {
  branch: string | null
  worktreePath: string | null
  id: string
}): string {
  if (chat.branch) {
    return `ws:${chat.id}`
  }
  if (chat.worktreePath) {
    return `path:${chat.worktreePath}`
  }
  return `ws:${chat.id}`
}

/**
 * Check if a scope key represents a shared (local-mode) terminal scope.
 */
export function isSharedTerminalScope(scopeKey: string): boolean {
  return scopeKey.startsWith("path:")
}

/**
 * Escape file paths for shell usage.
 * Wraps paths containing spaces in quotes.
 *
 * @param paths - Array of file paths
 * @returns Space-separated string of escaped paths
 */
export function shellEscapePaths(paths: string[]): string {
  return paths
    .map((p) => {
      // If path contains spaces, special chars, or is empty, quote it
      if (!p || /[\s'"\\$`!]/.test(p)) {
        // Escape any existing double quotes and wrap in double quotes
        return `"${p.replace(/"/g, '\\"')}"`
      }
      return p
    })
    .join(" ")
}
