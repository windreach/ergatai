/**
 * Agent Contract API — matches Ergatai backend API responses
 *
 * Backend endpoints:
 * - GET /api/v1/agents → AgentInfoResponse[]
 * - POST /api/v1/agents → spawn agent
 * - DELETE /api/v1/agents/:id → kill agent
 * - POST /api/v1/agents/:id/message → send message
 * - GET /api/v1/conversations → ConversationSummary[]
 * - GET /api/v1/agent-profiles → profile templates
 */

export type AgentId = string
export type AgentStatus = "idle" | "working" | "error" | "unknown"

// ── Backend API Response Types ─────────────────────────────────────────

/** Config option reported by agent (e.g., auto-approval mode, plan mode) */
export interface ConfigOptionInfo {
  id: string
  name: string
  description: string | null
  category: string | null
  kind: any // JSON value from backend
}

/** Agent info from GET /api/v1/agents */
export interface AgentInfoResponse {
  agent_id: string
  stable_id: string | null
  agent_uuid: string
  workspace_id: string
  work_dir: string
  state: string
  lifecycle_state: string
  task_id: string | null
  mcp_agent_id: string | null
  is_alive: boolean
  is_idle: boolean
  is_processing: boolean
  created_at: string
  last_heartbeat: string
  session_title: string | null
  session_id: string | null
  stop_reason: string | null
  continuation_count: number
  config_options: ConfigOptionInfo[] | null
  profile: string | null
  capabilities: string[]
  state_changed_at: string
  state_history: Array<{
    from: string
    to: string
    timestamp: string
    reason: string | null
  }>
}

/** Conversation from GET /api/v1/conversations (更新以匹配后端 BackendConversation) */
export interface ConversationSummary {
  id: string
  workspace_id: string | null
  name: string | null
  mode: string
  created_at: number
  updated_at: number
  archived_at: number | null
}

/** Agent profile template from GET /api/v1/agent-profiles */
export interface AgentProfile {
  name: string
  command: string
  agent_type: string
  package_name: string | null
  created_at: string
}

/** Agent profile with installation status from GET /api/v1/agent-profiles/with-status */
export interface AgentProfileWithStatus {
  id: string
  name: string
  command: string
  agent_type: string
  package_name: string | null
  avatar_url: string | null
  installed: boolean
  created_at: string
}

// ── Frontend Display Types (mapped from backend) ───────────────────────

/** Simplified agent summary for UI display */
export interface AgentSummary {
  id: string
  name: string
  description: string
  status: AgentStatus
  conversationCount: number
  // Extended fields from backend
  workspaceId: string
  profile: string | null
  sessionTitle: string | null
  capabilities: string[]
  configOptions: ConfigOptionInfo[] | null
  isAlive: boolean
  createdAt: string
}

/** Conversation for UI display (mapped from backend ConversationSummary) */
export interface AgentConversation {
  id: string
  agentId: string
  title: string
  preview: string
  status: "active" | "completed" | "failed"
  updatedAt: string
  messageCount: number
  // Extended fields
  participantA: string
  participantB: string
  completedRounds: number
}

// ── Core Agent Options (templates for spawning) ────────────────────────

export type CoreAgentId =
  | "claude-code"
  | "codex"
  | "opencode"
  | "cursor"
  | "gemini"
  | "goose"
  | "cline"
  | "kiro"
  | "auggie"
  | "hermes"
  | "openclaw"

export interface CoreAgentOption {
  id: CoreAgentId
  name: string
  description?: string
  defaultCommand?: string
  profileName?: string
}

export const CORE_AGENT_OPTIONS: CoreAgentOption[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    description: "Anthropic's terminal coding agent",
    defaultCommand: "claude",
    profileName: "claude",
  },
  {
    id: "codex",
    name: "Codex",
    description: "OpenAI's terminal coding agent",
    defaultCommand: "codex",
    profileName: "codex",
  },
  {
    id: "opencode",
    name: "OpenCode",
    description: "Open-source terminal coding agent (native ACP)",
    defaultCommand: "opencode acp",
    profileName: "opencode",
  },
  {
    id: "cursor",
    name: "Cursor",
    description: "AI code editor and CLI bridge",
    defaultCommand: "cursor-agent",
    profileName: "cursor",
  },
]

export function getCoreAgentOption(agentId: CoreAgentId): CoreAgentOption {
  return CORE_AGENT_OPTIONS.find((agent) => agent.id === agentId) ?? CORE_AGENT_OPTIONS[0]
}

export function getCoreAgentProfileName(agent: CoreAgentOption): string {
  return agent.profileName ?? agent.defaultCommand?.trim() ?? agent.id
}

/**
 * Map a raw core agent id / profile name (e.g. "opencode") to its canonical
 * display name (e.g. "OpenCode"). Returns undefined for unknown values so
 * callers can fall back to the raw name (custom profiles, runtime ids, ...).
 */
export function getCoreAgentDisplayName(
  idOrProfile?: string | null,
): string | undefined {
  const key = idOrProfile?.trim().toLowerCase()
  if (!key) return undefined
  return CORE_AGENT_OPTIONS.find(
    (agent) => agent.id === key || agent.profileName === key,
  )?.name
}

/**
 * Resolve a raw sender id/name (e.g. "claude-code", "Claude Code", "codex")
 * to a known core agent. Returns null when nothing matches so callers can
 * fall back to the raw value instead of guessing.
 *
 * @param rawValues - Array of potential agent identifiers (id, name, command, etc.)
 * @returns CoreAgentId if a match is found, null otherwise
 */
export function resolveCoreAgentId(
  ...rawValues: Array<string | undefined>
): CoreAgentId | null {
  const haystacks = rawValues
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map((value) => value.toLowerCase())
  if (haystacks.length === 0) return null

  for (const agent of CORE_AGENT_OPTIONS) {
    const needles = [agent.id, agent.name, agent.profileName, agent.defaultCommand]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .map((value) => value.toLowerCase())
    if (needles.some((needle) => haystacks.some((haystack) => haystack.includes(needle)))) {
      return agent.id
    }
  }
  return null
}

// ── Legacy types (kept for backward compatibility with UI components) ──

export const DEFAULT_INSTALLED_CORE_AGENT_IDS: CoreAgentId[] = [
  "claude-code",
  "codex",
  "opencode",
]

/** Agent registration for UI (stored in localStorage via jotai atoms) */
export interface AgentRegistration {
  id: string  // Backend-generated profile ID, used for linking/referencing
  name: string  // Display name (user-friendly, can be changed)
  runtimeId: CoreAgentId
  startupCommand: string
  avatarUrl?: string
}

// ── Contract Interface ─────────────────────────────────────────────────

export interface AgentContractApi {
  listAgents(): Promise<AgentSummary[]>
  listConversations(agentId?: AgentId): Promise<AgentConversation[]>
  listCoreAgents(): Promise<CoreAgentOption[]>
  // Extended methods for backend features
  spawnAgent(command: string, workspaceId: string, instruction?: string): Promise<string>
  killAgent(agentId: string): Promise<void>
  sendMessage(agentId: string, message: string): Promise<void>
  listProfiles(): Promise<AgentProfile[]>
  listProfilesWithStatus(): Promise<AgentProfileWithStatus[]>
  installAgent(name: string): Promise<{ status: string; message: string; output: string }>
  uninstallAgent(name: string): Promise<{ status: string; message: string; output: string }>
  registerAgent(
    name: string,
    command: string,
    agentType: string,
    packageName?: string,
    avatarUrl?: string,
  ): Promise<{ id: string }>
}

// ── Helper: Map backend state to frontend status ───────────────────────

function mapLifecycleState(lifecycleState: string, isAlive: boolean): AgentStatus {
  if (!isAlive) return "error"
  switch (lifecycleState.toLowerCase()) {
    case "running":
    case "processing":
    case "working":
      return "working"
    case "idle":
    case "waiting":
      return "idle"
    case "failed":
    case "dead":
    case "zombie":
      return "error"
    default:
      return "unknown"
  }
}

function text(value: unknown, fallback = "") {
  return typeof value === "string" && value.trim() ? value : fallback
}

function array<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

/** Map backend AgentInfoResponse to frontend AgentSummary */
function mapAgentToSummary(agent: AgentInfoResponse, index = 0): AgentSummary {
  const agentId = text(
    agent?.agent_id,
    text(agent?.agent_uuid, text(agent?.stable_id, `unknown-agent-${index}`)),
  )
  const stableId = text(agent?.stable_id)
  const sessionTitle = text(agent?.session_title)
  const profile = text(agent?.profile)

  return {
    id: agentId,
    name: sessionTitle || stableId || agentId,
    description: profile ? `Profile: ${profile}` : `Agent ${stableId || agentId}`,
    status: mapLifecycleState(text(agent?.lifecycle_state, text(agent?.state, "unknown")), Boolean(agent?.is_alive)),
    conversationCount: 0, // TODO: aggregate from sessions
    workspaceId: text(agent?.workspace_id, "default"),
    profile: profile || null,
    sessionTitle: sessionTitle || null,
    capabilities: array<string>(agent?.capabilities),
    configOptions: agent?.config_options ?? null,
    isAlive: Boolean(agent?.is_alive),
    createdAt: text(agent?.created_at, new Date().toISOString()),
  }
}

/** Map backend ConversationSummary (BackendConversation) to frontend AgentConversation */
function mapConversation(conv: ConversationSummary, agentId?: string): AgentConversation {
  const conversationId = text(conv?.id, `conversation-unknown`)
  const title = text(conv?.name, `Conversation ${conversationId.slice(0, 8)}`)
  const mode = text(conv?.mode, "unknown")
  const updatedAt = conv?.updated_at
    ? new Date(conv.updated_at * 1000).toISOString()
    : new Date().toISOString()

  // TODO: Backend no longer provides a status field on conversations.
  // Default to "active" — the old code inferred status from a `state` field
  // which no longer exists. Matching against `mode` (plan/agent/group) is
  // semantically incorrect and would never match status keywords.
  const status: "active" | "completed" | "failed" = "active"

  return {
    id: conversationId,
    agentId: agentId || "unknown-agent",
    title,
    preview: `Mode: ${mode}`,
    status,
    updatedAt,
    messageCount: 0, // 后端不再提供此字段
    participantA: agentId || "unknown-agent",
    participantB: "unknown-agent",
    completedRounds: 0, // 后端不再提供此字段
  }
}

// ── tRPC Client (IPC to main process → Ergatai backend) ────────────────

import { trpcClient } from "../../../lib/trpc"

// ── Real Implementation (via tRPC IPC) ─────────────────────────────────

export const agentContractApi: AgentContractApi = {
  async listAgents() {
    const agents = await trpcClient.ergatai.listAgents.query()
    return array<AgentInfoResponse>(agents).map((agent, index) =>
      mapAgentToSummary(agent, index),
    )
  },

  async listConversations(agentId?: string) {
    // 使用新的 listConversations API（替代旧的 listRuntimeConversations）
    const conversations = await trpcClient.ergatai.listConversations.query()
    const convs = array<ConversationSummary>(conversations)
    // 注意：新的 API 不再支持按 agentId 过滤，返回所有对话
    // 如果需要过滤，可以在调用后根据 workspace_id 或其他字段过滤
    return convs.map((c) => mapConversation(c, agentId))
  },

  async listCoreAgents() {
    try {
      const response = await trpcClient.ergatai.listProfilesWithStatus.query()
      const profiles = response.profiles || []

      // Only expose installed agents as selectable options
      const optionsById = new Map<CoreAgentId, CoreAgentOption>()

      for (const profile of profiles.filter((p) => p.installed)) {
        const id = (profile.name === "claude" ? "claude-code" : profile.name) as CoreAgentId
        const option: CoreAgentOption = {
          id,
          name: profile.name === "claude" ? "Claude Code" : profile.name,
          description: `Installed (${profile.agent_type})`,
          defaultCommand: profile.command,
          profileName: profile.name,
        }

        // Older databases may contain both "claude" and a legacy
        // "claude-code" profile. Keep the current canonical mapping.
        if (!optionsById.has(id) || profile.name === "claude") {
          optionsById.set(id, option)
        }
      }

      return [...optionsById.values()]
    } catch {
      // Fallback to static list if backend is unreachable
      return CORE_AGENT_OPTIONS.map((agent) => ({ ...agent }))
    }
  },

  async spawnAgent(command, workspaceId, instruction) {
    const response = await trpcClient.ergatai.spawnAgent.mutate({
      workspaceId,
      command,
      instruction,
    })
    return response.agent_id
  },

  async killAgent(agentId) {
    await trpcClient.ergatai.killAgent.mutate({ agentId })
  },

  async sendMessage(agentId, message) {
    await trpcClient.ergatai.sendMessage.mutate({ agentId, message })
  },

  async listProfiles() {
    const response = await trpcClient.ergatai.listProfiles.query()
    return response.profiles
  },

  async listProfilesWithStatus() {
    const response = await trpcClient.ergatai.listProfilesWithStatus.query()
    return response.profiles
  },

  async installAgent(name) {
    return trpcClient.ergatai.installAgent.mutate({ name })
  },

  async uninstallAgent(name) {
    return trpcClient.ergatai.uninstallAgent.mutate({ name })
  },

  async registerAgent(name, command, agentType, packageName, avatarUrl) {
    const result = await trpcClient.ergatai.registerProfile.mutate({
      name,
      command,
      agentType,
      packageName,
      avatarUrl,
    })
    if (result?.id) {
      return { id: result.id }
    }

    // The backend's success response may use a minimal shape in some error
    // paths. Resolve the backend-owned ID instead of creating one locally.
    const profiles = await trpcClient.ergatai.listProfiles.query()
    const profile = profiles.profiles.find((p) => p.name === name)
    return { id: profile?.id || name }
  },
}
