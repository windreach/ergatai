import type { CoreAgentId } from "../lib/agent-contract-api"

export type AgentParticipantStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "idle"
  | "unknown"

export type AgentParticipantSource = "group" | "runtime"

export interface AgentParticipant {
  activity: string
  agentId: string
  coreAgentId?: CoreAgentId
  key: string
  name: string
  /** Runtime agent profile id from the backend (e.g. "opencode", "claude-code") */
  profile?: string | null
  source: AgentParticipantSource
  status: AgentParticipantStatus
  conversationId?: string
  workspaceId?: string
}
