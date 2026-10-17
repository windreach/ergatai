/**
 * Slash command types for agent chat
 */

export type SlashCommandCategory = "builtin" | "agent"

export interface SlashCommand {
  id: string
  name: string // Display name without slash, e.g. "clear", "help"
  description: string
  category: SlashCommandCategory
  // For custom commands - hint for expected arguments (e.g. "[file_path]")
  argumentHint?: string
}

export interface SlashCommandOption extends SlashCommand {
  // Full command string for display, e.g. "/clear"
  command: string
}

// Trigger payload for slash command dropdown
export interface SlashTriggerPayload {
  searchText: string
  rect: DOMRect
}

// Builtin command action handlers
export type BuiltinCommandAction =
  | { type: "clear" }
  | { type: "plan" }
  | { type: "agent" }
  | { type: "compact" }
  // Prompt-based commands (send to agent)
  | { type: "review" }
  | { type: "pr-comments" }
  | { type: "release-notes" }
  | { type: "security-review" }
  | { type: "commit" }
  | { type: "worktree-setup" }

// Result of selecting a slash command
export type SlashCommandSelection = {
  category: "builtin"
  action: BuiltinCommandAction
}
