// Modified from 1Code (Apache-2.0) by Ergatai — see MODIFICATIONS.md
export { Terminal } from "./terminal"
export { TerminalSidebar } from "./terminal-sidebar"
export { TerminalBottomPanelContent } from "./terminal-sidebar"
export { getTerminalScopeKey } from "./utils"
export { getDefaultTerminalBg } from "./helpers"
export { killTerminalSession } from "./providers"
export { TerminalSearch } from "./TerminalSearch"
export * from "./atoms"
export {
  useActiveAgentTerminal,
  AgentTerminalPane,
  AgentTerminalTab,
  agentTerminalStatusLabel,
} from "./agent-terminal-view"
export type { TerminalProps, TerminalStreamEvent, TerminalInstance } from "./types"
