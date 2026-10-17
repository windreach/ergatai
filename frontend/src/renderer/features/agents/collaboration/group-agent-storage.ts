import {
  getCoreAgentOption,
  type CoreAgentId,
  type CoreAgentOption,
} from "../lib/agent-contract-api"

const STORAGE_PREFIX = "agents:group-agents:"
const DEFAULT_GROUP_AGENTS = [getCoreAgentOption("claude-code")]

export function hasStoredGroupAgentIds(chatId: string | null | undefined) {
  const storageKey = getGroupAgentStorageKey(chatId)
  return Boolean(storageKey && window.localStorage.getItem(storageKey))
}

export function getGroupAgentStorageKey(chatId: string | null | undefined) {
  return chatId ? `${STORAGE_PREFIX}${chatId}` : null
}

function normalizeGroupAgent(value: unknown): CoreAgentOption | null {
  if (typeof value === "string") {
    return getCoreAgentOption(value as CoreAgentId)
  }

  if (!value || typeof value !== "object") return null

  const agent = value as Partial<CoreAgentOption>
  if (typeof agent.id !== "string" || !agent.id) return null

  const fallback = getCoreAgentOption(agent.id as CoreAgentId)
  return {
    id: agent.id as CoreAgentId,
    name: typeof agent.name === "string" && agent.name ? agent.name : fallback.name,
    description:
      typeof agent.description === "string" ? agent.description : fallback.description,
    defaultCommand:
      typeof agent.defaultCommand === "string"
        ? agent.defaultCommand
        : fallback.defaultCommand,
    profileName:
      typeof agent.profileName === "string" && agent.profileName
        ? agent.profileName
        : fallback.profileName,
  }
}

function dedupeGroupAgents(agents: CoreAgentOption[]): CoreAgentOption[] {
  const seen = new Set<string>()
  return agents.filter((agent) => {
    if (seen.has(agent.id)) return false
    seen.add(agent.id)
    return true
  })
}

export function loadGroupAgents(
  chatId: string | null | undefined,
): CoreAgentOption[] {
  const storageKey = getGroupAgentStorageKey(chatId)
  if (!storageKey) return DEFAULT_GROUP_AGENTS

  try {
    const rawValue = window.localStorage.getItem(storageKey)
    if (!rawValue) return DEFAULT_GROUP_AGENTS

    const parsedValue = JSON.parse(rawValue)
    if (!Array.isArray(parsedValue)) return DEFAULT_GROUP_AGENTS

    const agents = dedupeGroupAgents(
      parsedValue
        .map(normalizeGroupAgent)
        .filter((agent): agent is CoreAgentOption => Boolean(agent)),
    )

    return agents.length > 0 ? agents : DEFAULT_GROUP_AGENTS
  } catch {
    return DEFAULT_GROUP_AGENTS
  }
}

export function loadGroupAgentIds(
  chatId: string | null | undefined,
): CoreAgentId[] {
  return loadGroupAgents(chatId).map((agent) => agent.id)
}

export function saveGroupAgentIds(
  chatId: string | null | undefined,
  agentIds: CoreAgentId[],
) {
  const storageKey = getGroupAgentStorageKey(chatId)
  if (!storageKey || agentIds.length === 0) return

  try {
    // Convert IDs to CoreAgentOption objects for consistent storage format
    const agents = agentIds.map((id) => getCoreAgentOption(id))
    window.localStorage.setItem(storageKey, JSON.stringify(agents))
  } catch {
    return
  }
}

export function saveGroupAgents(
  chatId: string | null | undefined,
  agents: CoreAgentOption[],
) {
  const storageKey = getGroupAgentStorageKey(chatId)
  if (!storageKey || agents.length === 0) return

  try {
    window.localStorage.setItem(storageKey, JSON.stringify(agents))
  } catch {
    return
  }
}

export function resolveGroupMentionAgents(
  groupAgentIds: CoreAgentId[],
  boundGroupAgents: CoreAgentOption[],
): CoreAgentOption[] {
  if (groupAgentIds.length === 0) return []
  if (boundGroupAgents.length > 0) return boundGroupAgents

  return groupAgentIds.map(getCoreAgentOption)
}
