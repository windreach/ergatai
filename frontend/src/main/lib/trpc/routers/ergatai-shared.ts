/**
 * Ergatai Backend API Router
 *
 * Proxies requests to the Ergatai backend (localhost:3000) via tRPC IPC.
 * This keeps network requests in the main process for security.
 */

import { z } from "zod"
import { observable } from "@trpc/server/observable"
import { publicProcedure, router } from "../index"
import { ergataiFetch, getErgataiAuthConfig, isErgataiApiError, ErgataiApiError } from "../../ergatai/api"
import {
  agentIdSchema,
  chatIdSchema,
  clientRequestIdSchema,
  conversationKeySchema,
  messageIdSchema,
  projectIdSchema,
} from "../../validation/ids"
import {
  subscribeRawAgentStream,
  subscribeConversationMessages,
  subscribeConversationRuntime,
  type AgentOutputEvent,
  type ConversationRuntimeStreamEvent,
} from "../../ergatai/sse-client"
import { getModelSnapshotManager } from "../../model-snapshot-manager"
import { loadSnapshots } from "../../model-snapshot-store"
import { terminalManager } from "../../terminal"
import { mkdir } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import type {
  AgentPlan,
  BackendAgentBinding,
  BackendChat,
  BackendConversation,
  BackendManagedWorkspace,
  BackendMessage,
  BackendProject,
  BackendWorkspaceProject,
  BackendWorkspace,
  BackendWorkspaceStatus,
} from "../../ergatai/user-data"

export type BackendActivityEvent =
  | {
      type: "agent_message"
      from_agent: string
      to_agent: string
      content_preview: string
      message_type: string
    }
  | {
      type: "agent_lifecycle"
      agent_id: string
      state: string
      workspace_id: string | null
    }
  | { type: "lock_acquired"; agent_id: string; file_path: string; mode: string }
  | { type: "lock_released"; agent_id: string; file_path: string }
  | { type: "dag_node_complete"; dag_id: string; node_id: string; agent_id: string }
  | {
      type: "dag_node_failed"
      dag_id: string
      node_id: string
      agent_id: string
      error: string
    }
  | { type: "dag_complete"; dag_id: string }
  | { type: "dag_node_warned"; dag_id: string; node_id: string; message: string }
  | { type: "dag_node_escalated"; dag_id: string; node_id: string; message: string }

export type BackendActivityEntry = {
  id: string
  timestamp: string
  event: BackendActivityEvent
}

export type BackendConversationFileChange = {
  filePath: string
  displayPath: string
  additions: number
  deletions: number
}

export type CollaborationRuntimeEvent = Record<string, unknown>

export type CollaborationSessionRuntimeMode = "supervisor" | "group"

export type CollaborationSessionState =
  | "idle"
  | "planning"
  | "executing"
  | "waiting_input"
  | "waiting_approval"
  | "synthesizing"
  | "completed"
  | "failed"
  | "cancelled"

export type CollaborationSessionParticipant = {
  id: string
  session_id: string
  conversation_id: string  // ✅ 新增：Conversation ID
  agent_id: string  // 保留：Agent ID（从 conversation 获取）
  role: string
  status: string
}

export type CollaborationSession = {
  id: string
  chat_id: string
  workspace_id: string | null
  project_id: string | null
  mode: CollaborationSessionRuntimeMode
  state: CollaborationSessionState
  goal: string | null
  active_plan_revision: string | null
}

export type CollaborationSessionDetail = CollaborationSession & {
  participants: CollaborationSessionParticipant[]
}

// Event payload types - discriminated union based on event type
export type TaskEventPayload = {
  nodeId?: string
  task?: string
  error?: string
  resultPath?: string
  status?: string
  agent?: string
}

export type PlanRevisionPayload = {
  revision?: number
}

export type ApprovalPayload = {
  kind?: string
  status?: string
}

export type DagEventPayload = {
  submittedNodes?: number
  failed?: number
  completed?: number
  summary?: string
  status?: string
}

export type SessionStatePayload = {
  from?: string
  to?: string
  status?: string
}

export type CollaborationEventPayload =
  | TaskEventPayload
  | PlanRevisionPayload
  | ApprovalPayload
  | DagEventPayload
  | SessionStatePayload
  | Record<string, unknown>

export type CollaborationContextEvent = {
  id: string
  session_id: string
  sequence: number
  type: string
  actor_type: string
  actor_id: string | null
  payload: CollaborationEventPayload
  visibility: string
  artifact_refs: string[]
}

export type CollaborationInteractionResult = CollaborationSessionDetail & {
  event_id?: string | null
  event_sequence?: number | null
  route?: "auto" | "lightweight" | "collaboration"
}

export type BackendCollaborationSessionDetail = Omit<CollaborationSessionDetail, "id"> & {
  collaboration_session_id: string
}

export type BackendCollaborationInteractionResult = Omit<CollaborationInteractionResult, "id"> & {
  collaboration_session_id: string
  activation?: Record<string, unknown>
}

export function mapCollaborationSessionDetail(
  session: BackendCollaborationSessionDetail,
): CollaborationSessionDetail {
  return {
    ...session,
    id: session.collaboration_session_id,
  }
}

export function mapCollaborationInteractionResult(
  result: BackendCollaborationInteractionResult,
): CollaborationInteractionResult {
  return {
    ...result,
    id: result.collaboration_session_id,
  }
}

export type Project = {
  id: string
  name: string
  path: string
  createdAt: Date
  updatedAt: Date
  gitRemoteUrl: string | null
  gitProvider: string | null
  gitOwner: string | null
  gitRepo: string | null
  iconPath: string | null
}

export type Chat = {
  id: string
  name: string | null
  workspaceId: string
  collaborationMode: string
  createdAt: Date
  updatedAt: Date
  archivedAt: Date | null
  worktreePath: string | null
  branch: string | null
  baseBranch: string | null
  prUrl: string | null
  prNumber: number | null
}

export type Workspace = {
  id: string
  name: string | null
  workDir: string
  env: Record<string, string>      // 解析后的 JSON
  resources: Record<string, unknown>   // 解析后的 JSON
  captureThoughts: boolean
  collaborationMode: string
  status: string
  defaultProjectId: string | null  // 默认展示的项目 ID
  projects: WorkspaceProject[]
  createdAt: Date
  updatedAt: Date
}

export type WorkspaceProject = {
  workspaceId: string
  projectId: string
  projectName: string
  projectPath: string
  isDefault: boolean
  status: string
  settingsJson: string
  createdAt: Date
  updatedAt: Date
}

export type WorkspaceStatus = {
  workspaceId: string
  status: string
  workDir: string
  workDirExists: boolean
  projectCount: number
  activeAgentCount: number
  conversationCount: number
  activeConversationCount: number
  worktreeCount: number
  dirtyWorktreeCount: number
  terminalCount: number
  healthy: boolean
}

export type Conversation = {
  id: string
  parentId: string | null
  projectId: string
  workspaceId: string | null
  title: string | null
  mode: string
  createdAt: Date
  updatedAt: Date
  archivedAt: Date | null
}

export type Message = {
  id: string
  conversationId: string
  sequence: number
  role: string
  parts: unknown[]
  metadata: Record<string, unknown> | null
  // Agent消息专用字段（新增）
  fromAgentId: string | null
  fromAgentName: string | null
  messageType: string | null
  content: string | null
  turnId: string | null
  projectionKind: string | null
  originMessageId: string | null
  createdAt: Date
  updatedAt: Date
}

export type ErgataiProject = Project
export type ErgataiWorkspace = Workspace
export type ErgataiWorkspaceProject = WorkspaceProject
export type ErgataiWorkspaceStatus = WorkspaceStatus
export type ErgataiConversation = Conversation
export type ErgataiMessage = Message

export type AgentBinding = {
  workspaceId: string
  chatId: string
  agentId: string
  agentName: string
  agentCommand: string | null
  conversationId: string
  createdAt: Date
  updatedAt: Date
}

export function mapAgentBinding(binding: BackendAgentBinding): AgentBinding {
  return {
    workspaceId: binding.workspace_id,
    chatId: binding.chat_id,
    agentId: binding.agent_id,
    agentName: binding.agent_name,
    agentCommand: binding.agent_command,
    conversationId: binding.conversation_id,
    createdAt: new Date(binding.created_at * 1000),
    updatedAt: new Date(binding.updated_at * 1000),
  }
}

export function mapProject(project: BackendProject): Project {
  return {
    id: project.id,
    name: project.name,
    path: project.path,
    createdAt: new Date(project.created_at * 1000),
    updatedAt: new Date(project.updated_at * 1000),
    gitRemoteUrl: project.git_remote_url,
    gitProvider: project.git_provider,
    gitOwner: project.git_owner,
    gitRepo: project.git_repo,
    iconPath: project.icon_path,
  }
}

export function mapChat(chat: BackendChat): Chat {
  return {
    id: chat.id,
    name: chat.name,
    workspaceId: chat.workspace_id,
    collaborationMode: chat.collaboration_mode ?? "supervisor",
    createdAt: new Date(chat.created_at * 1000),
    updatedAt: new Date(chat.updated_at * 1000),
    archivedAt: chat.archived_at === null ? null : new Date(chat.archived_at * 1000),
    worktreePath: chat.worktree_path,
    branch: chat.branch,
    baseBranch: chat.base_branch,
    prUrl: chat.pr_url,
    prNumber: chat.pr_number,
  }
}

export function mapWorkspace(workspace: BackendWorkspace): Workspace {
  return {
    id: String(workspace.workspace_id),
    name: workspace.name,
    workDir: workspace.work_dir,
    env: JSON.parse(workspace.env || "{}"),
    resources: JSON.parse(workspace.resources || "{}"),
    captureThoughts: false,
    collaborationMode: workspace.collaboration_mode,
    status: workspace.status,
    defaultProjectId: workspace.default_project_id
      ? String(workspace.default_project_id)
      : null,
    projects: [],
    createdAt: new Date(workspace.created_at * 1000),
    updatedAt: new Date(workspace.updated_at * 1000),
  }
}

export function mapWorkspaceProject(project: BackendWorkspaceProject): WorkspaceProject {
  return {
    workspaceId: project.workspace_id,
    projectId: project.project_id,
    projectName: project.name,
    projectPath: project.path,
    isDefault: false, // Backend no longer has is_default field
    status: "active", // Backend no longer has status field, default to active
    settingsJson: "{}", // Backend no longer has settings_json field
    createdAt: new Date(project.created_at * 1000),
    updatedAt: new Date(project.updated_at * 1000),
  }
}

/** Map BackendWorkspaceProject to standalone Project type (for aggregated project views) */
export function mapWorkspaceProjectToProject(project: BackendWorkspaceProject): Project {
  return {
    id: project.project_id,
    name: project.name,
    path: project.path,
    createdAt: new Date(project.created_at * 1000),
    updatedAt: new Date(project.updated_at * 1000),
    gitRemoteUrl: project.git_remote_url,
    gitProvider: project.git_provider,
    gitOwner: project.git_owner,
    gitRepo: project.git_repo,
    iconPath: project.icon_path,
  }
}

export function mapManagedWorkspace(workspace: BackendManagedWorkspace): Workspace {
  const base = mapWorkspace(workspace as unknown as BackendWorkspace)
  return {
    ...base,
    // BackendManagedWorkspace uses string workspace_id, handle default_project_id accordingly
    defaultProjectId: workspace.default_project_id ?? null,
    projects: (workspace.projects ?? []).map(mapWorkspaceProject),
  }
}

export function mapWorkspaceStatus(status: BackendWorkspaceStatus): WorkspaceStatus {
  return {
    workspaceId: status.workspace_id,
    status: status.status,
    workDir: status.work_dir,
    workDirExists: status.work_dir_exists,
    projectCount: status.project_count,
    activeAgentCount: status.active_agent_count,
    conversationCount: status.conversation_count,
    activeConversationCount: status.active_conversation_count,
    worktreeCount: status.worktree_count,
    dirtyWorktreeCount: status.dirty_worktree_count,
    terminalCount: 0,
    healthy: status.healthy,
  }
}

export function parseMessageParts(value: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function parseMessageMetadata(
  value: string | null,
): Record<string, unknown> | null {
  if (value === null) return null

  try {
    const parsed: unknown = JSON.parse(value)
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

export function mapConversation(conversation: BackendConversation): Conversation {
  return {
    id: conversation.id,
    parentId: conversation.parent_id,
    projectId: "",
    workspaceId: null,  // Backend doesn't provide workspace_id on conversations; fetch from chat if needed
    title: conversation.name,
    mode: conversation.mode,
    createdAt: new Date(conversation.created_at * 1000),
    updatedAt: new Date(conversation.updated_at * 1000),
    archivedAt: conversation.status === "archived"
      ? new Date(conversation.updated_at * 1000)
      : null,
  }
}

export function mapMessage(message: BackendMessage): Message {
  return {
    id: String(message.message_id),
    conversationId: String(message.conversation_id),
    sequence: message.sequence,
    role: message.role,
    parts: parseMessageParts(message.parts),
    metadata: parseMessageMetadata(message.metadata),
    // Agent消息专用字段
    fromAgentId: message.from_agent_id,
    fromAgentName: message.from_agent_name,
    messageType: message.message_type,
    content: message.content,
    turnId: message.turn_id,
    projectionKind: message.projection_kind,
    originMessageId: message.origin_message_id,
    createdAt: new Date(message.created_at * 1000),
    updatedAt: new Date(message.updated_at * 1000),
  }
}

export type LockInfo = {
  id: string
  file_path: string
  agent_id: string
  session_id: string
  mode: string
  scope: string
  created_at: string
  expires_at: string
  heartbeat_at: string
  status: string
}

export type LockAuditEntry = {
  id: string
  agent_id: string
  file_path: string
  action: string
  mode: string
  timestamp: string
}

export type LockContention = {
  file_path: string
  current_holder: string | null
  waiting_agents: string[]
  wait_time_secs: number
  conflict_count: number
}

export type MessageTypeStats = {
  message_type: string
  count: number
  percentage: number
}

export type DagSubmitResponse = {
  submitted_nodes: number
  progress: number
  graph_status: string
}

export type DagValidateResponse = {
  valid: boolean
  errors: string[]
  warnings: string[]
}

export type SystemConfig = {
  nats_initialized: boolean
  nats_port: number | null
  active_agents: number
  capture_thoughts: boolean | null
}

// ── Types (mirrored from backend) ──────────────────────────────────────

export const AgentInfoSchema = z.object({
  agent_id: z.string(),
  stable_id: z.string().nullable(),
  agent_uuid: z.string(),
  workspace_id: z.string(),
  work_dir: z.string(),
  state: z.string(),
  lifecycle_state: z.string(),
  task_id: z.string().nullable(),
  mcp_agent_id: z.string().nullable(),
  is_alive: z.boolean(),
  is_idle: z.boolean(),
  is_processing: z.boolean(),
  created_at: z.string(),
  last_heartbeat: z.string(),
  session_title: z.string().nullable(),
  session_id: z.string().nullable(),
  stop_reason: z.string().nullable(),
  continuation_count: z.number(),
  config_options: z.unknown().nullable(),
  profile: z.string().nullable(),
  capabilities: z.array(z.string()),
  state_changed_at: z.string(),
  state_history: z.array(z.unknown()),
})

export const ConversationSummarySchema = z.object({
  id: z.string(),
  agent_a: z.string(),
  agent_b: z.string(),
  state: z.string(),
  message_count: z.number(),
  completed_rounds: z.number(),
  started_at: z.string(),
  last_activity: z.string(),
})

export const AgentProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  command: z.string(),
  agent_type: z.string(),
  package_name: z.string().nullable(),
  avatar_url: z.string().nullable(),
  created_at: z.string(),
})

export const AgentProfileWithStatusSchema = z.object({
  id: z.string(),
  name: z.string(),
  command: z.string(),
  agent_type: z.string(),
  package_name: z.string().nullable(),
  avatar_url: z.string().nullable(),
  installed: z.boolean(),
  created_at: z.string(),
})

export const AgentPlanSchema = z.object({
  plan_id: z.string(),
  file_path: z.string(),
  status: z.enum(["active", "archived", "none"]),
  content: z.string(),
  created_at: z.number(),
  updated_at: z.number(),
})


// ── Helpers ──────────────────────────────────────────────────────────────────────

/**
 * Validate that a chatId has the correct format (starts with "chat_").
 * Returns false and logs a warning if invalid, preventing unnecessary API calls.
 */
export function isValidChatId(chatId: string, procedureName: string): boolean {
  if (!chatId.startsWith("chat_")) {
    console.warn(`[ergatai] ${procedureName}: invalid chatId format:`, chatId)
    return false
  }
  return true
}

// ── Re-exports of imported bindings for sub-routers ─────────────────────
export { z } from "zod"
export { observable } from "@trpc/server/observable"
export { publicProcedure, router } from "../index"
export { ergataiFetch, getErgataiAuthConfig, isErgataiApiError, ErgataiApiError } from "../../ergatai/api"
export {
  agentIdSchema,
  chatIdSchema,
  clientRequestIdSchema,
  conversationKeySchema,
  messageIdSchema,
  projectIdSchema,
} from "../../validation/ids"
export {
  subscribeRawAgentStream,
  subscribeConversationMessages,
  subscribeConversationRuntime,
} from "../../ergatai/sse-client"
export type {
  AgentOutputEvent,
  ConversationRuntimeStreamEvent,
} from "../../ergatai/sse-client"
export { getModelSnapshotManager } from "../../model-snapshot-manager"
export { loadSnapshots } from "../../model-snapshot-store"
export { terminalManager } from "../../terminal"
export { mkdir } from "fs/promises"
export { tmpdir } from "os"
export { join } from "path"
export type {
  AgentPlan,
  BackendAgentBinding,
  BackendChat,
  BackendConversation,
  BackendManagedWorkspace,
  BackendMessage,
  BackendProject,
  BackendWorkspaceProject,
  BackendWorkspace,
  BackendWorkspaceStatus,
} from "../../ergatai/user-data"
