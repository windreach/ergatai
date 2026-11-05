import claudeCodeLogo from "@/assets/agent-icons/claude-code.png"
import codexLogo from "@/assets/agent-icons/codex.png"
import opencodeLogo from "@/assets/agent-icons/opencode.png"

// Bundled original agent logos. These are served by Vite as hashed asset URLs.
export const CORE_AGENT_LOGO_URLS: Partial<Record<string, string>> = {
  "claude-code": claudeCodeLogo,
  codex: codexLogo,
  opencode: opencodeLogo,
}
