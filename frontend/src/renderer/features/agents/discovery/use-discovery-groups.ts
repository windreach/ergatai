import { useMemo } from "react"
import { trpc } from "../../../lib/trpc"

export interface DiscoveryGroupItem {
  name: string
  description?: string
  source?: string
  group: string
  type: "skill" | "command" | "mcp" | "plugin" | "agent"
  /** Explicit routing markers stamped at discovery/read time (preferred over dynamic trigger inference). */
  targetTriggers?: string[]
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
 * Items carry explicit type/targetTriggers markers from discovery sources when available.
 */
export interface DiscoveryTrigger {
  char: string
  position?: string
  types?: string[]
}

type RawDiscoveryItem = {
  name: string
  description?: string
  source?: string
  group?: string
  type?: string
  targetTriggers?: unknown
  status?: string
}

function normalizeTargetTriggers(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out = raw.filter((x): x is string => typeof x === "string" && x.length > 0)
  return out.length ? out : undefined
}

function normalizeItemType(raw: string | undefined, fallback: DiscoveryGroupItem["type"]): DiscoveryGroupItem["type"] {
  if (raw === "skill" || raw === "command" || raw === "mcp" || raw === "plugin" || raw === "agent") return raw
  return fallback
}

export function useDiscoveryGroups(agentId: string | undefined, cwd?: string, agentKind?: string) {
  // Full discovery: requires agentId
  const { data: fullData, isLoading: fullLoading } = trpc.discovery.getAgentDiscovery.useQuery(
    { agentId: agentId ?? "", cwd },
    { enabled: !!agentId, staleTime: 30 * 1000, refetchOnWindowFocus: false },
  )

  // Static fallback: convention_skills + plugins only, no agentId needed
  const { data: staticData, isLoading: staticLoading } = trpc.discovery.getStaticDiscovery.useQuery(
    { cwd, agent: agentKind },
    { enabled: !agentId, staleTime: 5 * 60 * 1000, refetchOnWindowFocus: false },
  )

  // Select the active data source
  const data = agentId ? fullData : staticData
  const isLoading = agentId ? fullLoading : staticLoading

  const triggers = useMemo<DiscoveryTrigger[]>(() => {
    const d = data as { triggers?: DiscoveryTrigger[] } | undefined
    return Array.isArray(d?.triggers) ? d.triggers : []
  }, [data])

  const groups = useMemo<DiscoveryGroup[]>(() => {
    const d = data as
      | {
          skills?: RawDiscoveryItem[]
          commands?: RawDiscoveryItem[]
          mcp?: RawDiscoveryItem[]
          plugins?: RawDiscoveryItem[]
          agents?: RawDiscoveryItem[]
        }
      | undefined

    const items: DiscoveryGroupItem[] = []
    const push = (raw: RawDiscoveryItem, fallbackType: DiscoveryGroupItem["type"], fallbackGroup: string) => {
      const type = normalizeItemType(raw.type, fallbackType)
      items.push({
        name: raw.name,
        description: raw.status || raw.description,
        source: raw.source || "agent-sdk",
        group: raw.group || fallbackGroup,
        type,
        targetTriggers: normalizeTargetTriggers(raw.targetTriggers),
      })
    }

    for (const s of d?.skills ?? []) push(s, "skill", "Skills")
    for (const c of d?.commands ?? []) push(c, "command", "Commands")
    for (const m of d?.mcp ?? []) push(m, "mcp", "MCP")
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