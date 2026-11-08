import { useMemo } from "react"
import { trpc } from "../../../lib/trpc"

export interface DiscoveryGroupItem {
  name: string
  description?: string
  source?: string
  group: string
  type: "skill" | "command" | "mcp" | "plugin" | "agent"
}

export interface DiscoveryGroup {
  id: string
  label: string
  items: DiscoveryGroupItem[]
}

const TYPE_LABELS: Record<string, string> = {
  skill: "Skills",
  command: "Commands",
  mcp: "MCP",
  plugin: "Plugins",
  agent: "Agents",
}

/**
 * Generic hook: fetch agent discovery and group items by backend-provided `group`.
 * Both `/` and `@` can consume this; insertion semantics stay in the caller.
 */
export interface DiscoveryTrigger {
  char: string
  position?: string
  types?: string[]
  allowSpaces?: boolean
}

export function useDiscoveryGroups(agentId: string | undefined, cwd?: string) {
  const { data, isLoading } = trpc.discovery.getAgentDiscovery.useQuery(
    { agentId: agentId ?? "", cwd },
    { enabled: !!agentId, staleTime: 30 * 1000, refetchOnWindowFocus: false },
  )

  const triggers = useMemo<DiscoveryTrigger[]>(() => {
    const d = data as { triggers?: DiscoveryTrigger[] } | undefined
    return Array.isArray(d?.triggers) ? d.triggers : []
  }, [data])

  const groups = useMemo<DiscoveryGroup[]>(() => {
    const d = data as
      | {
          skills?: Array<{ name: string; description?: string; source?: string; group?: string }>
          commands?: Array<{ name: string; description?: string; source?: string; group?: string }>
          mcp?: Array<{ name: string; description?: string; source?: string; group?: string; status?: string }>
          plugins?: Array<{ name: string; description?: string; source?: string; group?: string }>
          agents?: Array<{ name: string; description?: string; source?: string; group?: string }>
        }
      | undefined

    const items: DiscoveryGroupItem[] = []
    const push = (raw: { name: string; description?: string; source?: string; group?: string }, type: DiscoveryGroupItem["type"], fallback: string) => {
      items.push({
        name: raw.name,
        description: raw.description,
        source: raw.source || "agent-sdk",
        group: raw.group || fallback,
        type,
      })
    }

    for (const s of d?.skills ?? []) push(s, "skill", "Skills")
    for (const c of d?.commands ?? []) push(c, "command", "Commands")
    for (const m of d?.mcp ?? []) push({ name: m.name, description: m.status || m.description, source: m.source, group: m.group }, "mcp", "MCP")
    for (const p of d?.plugins ?? []) push(p, "plugin", "Plugins")
    for (const a of d?.agents ?? []) push(a, "agent", "Agents")

    // Dedup by name, first wins.
    const seen = new Set<string>()
    const deduped = items.filter((it) => {
      if (seen.has(it.name)) return false
      seen.add(it.name)
      return true
    })

    const byGroup = new Map<string, DiscoveryGroupItem[]>()
    for (const it of deduped) {
      if (!byGroup.has(it.group)) byGroup.set(it.group, [])
      byGroup.get(it.group)!.push(it)
    }

    return Array.from(byGroup.entries()).map(([id, its]) => ({
      id,
      label: TYPE_LABELS[id] || id,
      items: its,
    }))
  }, [data])

  return { groups, isLoading, triggers }
}