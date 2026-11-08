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
