import { router } from "../index"
import { claudeRouter } from "./claude"
import { projectsRouter } from "./projects"
import { chatsRouter } from "./chats"
import { claudeSettingsRouter } from "./claude-settings"
import { claudeCodeRouter } from "./claude-code"
import { ollamaRouter } from "./ollama"
import { terminalRouter } from "./terminal"
import { externalRouter } from "./external"
import { filesRouter } from "./files"
import { debugRouter } from "./debug"
import { skillsRouter } from "./skills"
import { agentsRouter } from "./agents"
import { ergataiRouter } from "./ergatai"
import { backendTerminalRouter } from "./backend-terminal"
import { worktreeConfigRouter } from "./worktree-config"
import { pluginsRouter } from "./plugins"
import { groupChatRouter } from "./group-chat"
import { testRouter } from "./test"
import { createGitRouter } from "../../git"
import { BrowserWindow } from "electron"

/**
 * Create the main app router
 * Uses getter pattern to avoid stale window references
 */
export function createAppRouter(getWindow: () => BrowserWindow | null) {
  return router({
    claude: claudeRouter,
    projects: projectsRouter,
    chats: chatsRouter,
    claudeSettings: claudeSettingsRouter,
    claudeCode: claudeCodeRouter,
    ollama: ollamaRouter,
    terminal: terminalRouter,
    external: externalRouter,
    files: filesRouter,
    debug: debugRouter,
    skills: skillsRouter,
    agents: agentsRouter,
    ergatai: ergataiRouter,
    backendTerminal: backendTerminalRouter,
    worktreeConfig: worktreeConfigRouter,
    plugins: pluginsRouter,
    groupChat: groupChatRouter,
    test: testRouter,  // 测试模式 IPC（只在 NODE_ENV=test 时可用）
    // Git operations - named "changes" to match Superset API
    changes: createGitRouter(),
  })
}

/**
 * Export the router type for client usage
 */
export type AppRouter = ReturnType<typeof createAppRouter>
