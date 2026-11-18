import { ALL_THINKING_LEVELS, CODEX_MODELS, type CodexThinkingLevel } from "./models"

type BackendModel = { id: string; name?: string }

export function buildCodexUiModels(
  backendModels: BackendModel[] | null | undefined,
  hiddenModels: string[],
): { id: string; name: string; thinkings: CodexThinkingLevel[] }[] {
  const hiddenModelSet = new Set(hiddenModels)
  const backend = backendModels ?? []
  const fromBackend = backend
    .filter((m) => !hiddenModelSet.has(m.id))
    .map((m) => ({
      id: m.id,
      name: m.name || m.id,
      thinkings:
        m.id.includes("codex") || m.id.startsWith("gpt-5")
          ? ALL_THINKING_LEVELS
          : (["medium", "high"] as CodexThinkingLevel[]),
    }))
  const backendIds = new Set(fromBackend.map((m) => m.id))
  const extra = CODEX_MODELS.filter(
    (m) => !backendIds.has(m.id) && !hiddenModelSet.has(m.id),
  )
  return fromBackend.length > 0
    ? [...fromBackend, ...extra]
    : [...CODEX_MODELS.filter((m) => !hiddenModelSet.has(m.id))]
}
