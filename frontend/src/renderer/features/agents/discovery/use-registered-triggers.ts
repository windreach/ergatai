import { useMemo } from "react"
import { trpc } from "../../../lib/trpc"

/**
 * Trigger configuration from backend.
 * Schema: char, position, types — no allowSpaces/maxLength (simplified).
 */
export interface RegisteredTrigger {
  char: string
  position?: "start-of-line" | "standalone" | "anywhere"
  types?: string[]
  kind?: "slash" | "mention"
}

/**
 * Hook: fetch registered triggers from backend.
 *
 * Triggers are independent of discovery — can be cached with longer TTL.
 * When agentId is provided, returns full triggers (all types).
 * Without agentId, returns static triggers (skill, plugin only).
 *
 * Usage:
 * ```tsx
 * const { triggers, isTriggerChar, getTriggerTypes } = useRegisteredTriggers(agentId, cwd)
 *
 * // Check if a character is a trigger
 * if (isTriggerChar("/")) { ... }
 *
 * // Get types for a trigger (for filtering discovery results)
 * const types = getTriggerTypes("/") // ["skill", "command", ...]
 * ```
 */
export function useRegisteredTriggers(
  agentId: string | undefined,
  cwd?: string
) {
  const { data, isLoading } = trpc.discovery.getTriggers.useQuery(
    { agentId, cwd },
    {
      // Triggers are stable config — cache for 5 minutes
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

  // Helper: check if a character is a registered trigger
  const isTriggerChar = useMemo(() => {
    const chars = new Set(triggers.map((t) => t.char))
    return (char: string) => chars.has(char)
  }, [triggers])

  // Helper: get types for a trigger character
  const getTriggerTypes = useMemo(() => {
    const map = new Map(triggers.map((t) => [t.char, t.types ?? []]))
    return (char: string) => map.get(char) ?? []
  }, [triggers])

  // Helper: get position rule for a trigger character
  const getTriggerPosition = useMemo(() => {
    const map = new Map(triggers.map((t) => [t.char, t.position ?? "anywhere"]))
    return (char: string) => map.get(char) ?? "anywhere"
  }, [triggers])

  return {
    triggers,
    isLoading,
    isTriggerChar,
    getTriggerTypes,
    getTriggerPosition,
  }
}

/**
 * Extract trigger config for a specific character from registered triggers.
 */
export function extractTriggerConfig(
  triggers: RegisteredTrigger[],
  char: string,
  defaultPosition: "standalone" | "start-of-line" | "anywhere",
): { char: string; position: "standalone" | "start-of-line" | "anywhere" } | undefined {
  const trigger = triggers.find((t) => t.char === char)
  return trigger
    ? { char: trigger.char, position: trigger.position ?? defaultPosition }
    : undefined
}

/**
 * Hook: extract editor trigger configs for @ and / from registered triggers.
 *
 * Convenience wrapper around useRegisteredTriggers that returns pre-extracted
 * configs for the two main editor triggers (mention and slash command).
 *
 * Usage:
 * ```tsx
 * const { mentionTrigger, slashTrigger } = useEditorTriggerConfigs(agentId, cwd)
 * // Pass to AgentsMentionsEditor: mentionTrigger, slashTrigger
 * ```
 */
export function useEditorTriggerConfigs(
  agentId: string | undefined,
  cwd?: string,
) {
  const { triggers } = useRegisteredTriggers(agentId, cwd)

  const mentionTrigger = useMemo(
    () => extractTriggerConfig(triggers, "@", "standalone"),
    [triggers],
  )

  const slashTrigger = useMemo(
    () => extractTriggerConfig(triggers, "/", "start-of-line"),
    [triggers],
  )

  const discoveryTriggers = useMemo(
    () =>
      triggers.map((t) => ({
        char: t.char,
        position: t.position ?? "anywhere",
        types: t.types,
        kind: t.kind ?? (t.char === "/" ? "slash" : "mention"),
      })),
    [triggers],
  )

  return { mentionTrigger, slashTrigger, discoveryTriggers }
}
