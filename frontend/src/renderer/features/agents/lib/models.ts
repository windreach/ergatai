export const CLAUDE_MODELS = [
  { id: "opus", name: "Opus", version: "4.6" },
  { id: "sonnet", name: "Sonnet", version: "4.6" },
  { id: "haiku", name: "Haiku", version: "4.5" },
]

export type CodexThinkingLevel = "low" | "medium" | "high" | "xhigh"

const ALL_THINKING_LEVELS: CodexThinkingLevel[] = ["low", "medium", "high", "xhigh"]

interface CodexModel {
  id: string
  name: string
  thinkings: CodexThinkingLevel[]
}

export const CODEX_MODELS: CodexModel[] = [
  {
    id: "gpt-5.3-codex",
    name: "Codex 5.3",
    thinkings: ALL_THINKING_LEVELS,
  },
  {
    id: "gpt-5.2-codex",
    name: "Codex 5.2",
    thinkings: ALL_THINKING_LEVELS,
  },
  {
    id: "gpt-5.1-codex-max",
    name: "Codex 5.1 Max",
    thinkings: ALL_THINKING_LEVELS,
  },
  {
    id: "gpt-5.1-codex-mini",
    name: "Codex 5.1 Mini",
    thinkings: ["medium", "high"],
  },
]

export function formatCodexThinkingLabel(thinking: CodexThinkingLevel): string {
  if (thinking === "xhigh") return "Extra High"
  return thinking.charAt(0).toUpperCase() + thinking.slice(1)
}
