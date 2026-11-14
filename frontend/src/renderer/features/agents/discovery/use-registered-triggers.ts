import { useMemo } from "react"
import { trpc } from "../../../lib/trpc"

/**
 * Trigger configuration from backend.
 * Backend may still provide capability/type hints, but editor grammar is owned
 * by Ergatai's built-in rules (see BUILTIN_EDITOR_TRIGGERS below).
 */
export interface RegisteredTrigger {
  char: string
  position?: "start-of-line" | "standalone" | "anywhere"
  types?: string[]
  kind?: "slash" | "mention"
}

export interface EditorTriggerConfig {
  char: string
  position: "standalone" | "start-of-line" | "anywhere"
  kind: "slash" | "mention"
  types?: string[]
}

/**
 * Built-in, product-owned trigger grammar.
 * Kept stable across agents/providers: agents contribute capabilities, not syntax.
 */
export const BUILTIN_EDITOR_TRIGGERS: readonly EditorTriggerConfig[] = [
  { char: "/", position: "start-of-line", kind: "slash", types: ["command", "skill", "plugin"] },
  { char: "@", position: "standalone", kind: "mention", types: ["file", "folder", "agent", "mcp", "skill", "command", "plugin", "tool"] },
  { char: "$", position: "standalone", kind: "mention", types: ["skill", "command", "plugin"] },
  { char: "#", position: "standalone", kind: "mention", types: ["file", "folder", "issue", "pr", "task"] },
] as const

const DEFAULT_TRIGGER_TYPES: Record<string, string[]> = Object.fromEntries(
  BUILTIN_EDITOR_TRIGGERS.map((t) => [t.char, [...(t.types ?? [])]]),
)

/**
 * Fetch backend discovery trigger metadata (types/capability hints).
 * Editor trigger detection should NOT depend on this; use BUILTIN_EDITOR_TRIGGERS.
 */
export function useRegisteredTriggers(
  agentId: string | undefined,
  cwd?: string
) {
  const { data, isLoading } = trpc.discovery.getTriggers.useQuery(
    { agentId, cwd },
    {
      // Triggers/capability hints are relatively stable — cache for 5 minutes
      staleTime: 5 * 60 * 1000,
      refetchOnWindowFocus: false,
    }
  )

  const triggers = useMemo<RegisteredTrigger[]>(() => {
    if (!data?.triggers) return []
    return data.triggers.map((t: Record<string, unknown>) => ({
      char: String(t.char ?? ""),
      position: t.position as RegisteredTrigger["position"],
      types: Array.isArray(t.types) ? t.types.map(String) : undefined,
      kind: t.kind === "slash" || t.kind === "mention" ? t.kind : undefined,
    }))
  }, [data])

  const backendTypesByChar = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const t of triggers) {
      if (t.char && Array.isArray(t.types)) map.set(t.char, t.types)
    }
    return map
  }, [triggers])

  // Helper: check if a character is a built-in editor trigger
  const isTriggerChar = useMemo(() => {
    const chars = new Set(BUILTIN_EDITOR_TRIGGERS.map((t) => t.char))
    return (char: string) => chars.has(char)
  }, [])

  // Helper: get capability/item types for a trigger character.
  // Prefers backend hints when present, otherwise falls back to built-in defaults.
  const getTriggerTypes = useMemo(() => {
    return (char: string) => backendTypesByChar.get(char) ?? DEFAULT_TRIGGER_TYPES[char] ?? []
  }, [backendTypesByChar])

  // Helper: get position rule for a built-in trigger character
  const getTriggerPosition = useMemo(() => {
    const map = new Map(BUILTIN_EDITOR_TRIGGERS.map((t) => [t.char, t.position]))
    return (char: string) => map.get(char) ?? "anywhere"
  }, [])

  return {
    triggers,
    isLoading,
    isTriggerChar,
    getTriggerTypes,
    getTriggerPosition,
  }
}

/**
 * Extract trigger config for a specific character.
 * Retained for compatibility; prefers built-in editor grammar.
 */
export function extractTriggerConfig(
  triggers: RegisteredTrigger[],
  char: string,
  defaultPosition: "standalone" | "start-of-line" | "anywhere",
): { char: string; position: "standalone" | "start-of-line" | "anywhere" } | undefined {
  const builtIn = BUILTIN_EDITOR_TRIGGERS.find((t) => t.char === char)
  if (builtIn) return { char: builtIn.char, position: builtIn.position }
  const trigger = triggers.find((t) => t.char === char)
  return trigger
    ? { char: trigger.char, position: trigger.position ?? defaultPosition }
    : undefined
}

/**
 * Hook: editor trigger configs are product-owned and stable.
 * Backend discovery/agent metadata must not change trigger grammar.
 */
export function useEditorTriggerConfigs(
  _agentId: string | undefined,
  _cwd?: string,
) {
  const mentionTrigger = useMemo(
    () => BUILTIN_EDITOR_TRIGGERS.find((t) => t.char === "@"),
    [],
  )

  const slashTrigger = useMemo(
    () => BUILTIN_EDITOR_TRIGGERS.find((t) => t.char === "/"),
    [],
  )

  const discoveryTriggers = useMemo(
    () => BUILTIN_EDITOR_TRIGGERS.map((t) => ({ ...t, types: [...(t.types ?? [])] })),
    [],
  )

  return { mentionTrigger, slashTrigger, discoveryTriggers }
}
