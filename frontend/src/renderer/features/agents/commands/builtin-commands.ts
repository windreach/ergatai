import type { BuiltinCommandAction, SlashCommandOption } from "./types"

/**
 * Prompt texts for prompt-based slash commands
 */
export const COMMAND_PROMPTS: Partial<
  Record<BuiltinCommandAction["type"], string>
> = {
  review:
    "Please review the code in the current context and provide feedback on code quality, potential bugs, and improvements.",
  "pr-comments":
    "Generate detailed PR review comments for the changes in the current context.",
  "release-notes":
    "Generate release notes summarizing the changes in this codebase.",
  "security-review":
    "Perform a security audit of the code in the current context. Identify vulnerabilities, security risks, and suggest fixes.",
  commit:
    "Закоммить это аккуратно, не трогая больше ничего. Сделай коммит только для staged изменений, не добавляй никакие другие файлы и не вноси дополнительных изменений.",
  "worktree-setup": `Create a worktree setup script for this project.

Your task:
1. Analyze the project to understand what's needed to set up a working copy
2. Create the file .ergatai/worktree.json with setup commands

The goal is to reproduce the EXACT same working state as the original repo in the new worktree.

Rules:
- Use only "setup-worktree" key (works on all platforms)
- Install dependencies using the project's package manager (check for bun.lockb, pnpm-lock.yaml, yarn.lock, package-lock.json)
- Copy ALL real env files that exist (.env, .env.local, .env.development, etc) - NOT example files
- Use $ROOT_WORKTREE_PATH to reference the main repo path
- Don't include build steps unless absolutely necessary for the project to work

Example output for .ergatai/worktree.json:
{
  "setup-worktree": [
    "bun install",
    "cp $ROOT_WORKTREE_PATH/.env .env",
    "cp $ROOT_WORKTREE_PATH/.env.local .env.local"
  ]
}

Now analyze this project and create .ergatai/worktree.json with the appropriate setup commands.`,
}

/**
 * Check if a command is a prompt-based command
 */
export function isPromptCommand(
  type: BuiltinCommandAction["type"],
): type is "review" | "pr-comments" | "release-notes" | "security-review" | "commit" | "worktree-setup" {
  return type in COMMAND_PROMPTS
}

