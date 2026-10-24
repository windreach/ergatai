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

type BackendActivityEvent =
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

type BackendActivityEntry = {
  id: string
  timestamp: string
  event: BackendActivityEvent
}

type BackendConversationFileChange = {
  filePath: string
  displayPath: string
  additions: number
  deletions: number
}

type CollaborationRuntimeEvent = Record<string, unknown>

type CollaborationSessionRuntimeMode = "supervisor" | "group"

type CollaborationSessionState =
  | "idle"
  | "planning"
  | "executing"
  | "waiting_input"
  | "waiting_approval"
  | "synthesizing"
  | "completed"
  | "failed"
  | "cancelled"

type CollaborationSessionParticipant = {
  id: string
  session_id: string
  conversation_id: string  // ✅ 新增：Conversation ID
  agent_id: string  // 保留：Agent ID（从 conversation 获取）
  role: string
  status: string
}

type CollaborationSession = {
  id: string
  chat_id: string
  workspace_id: string | null
  project_id: string | null
  mode: CollaborationSessionRuntimeMode
  state: CollaborationSessionState
  goal: string | null
  active_plan_revision: string | null
}

type CollaborationSessionDetail = CollaborationSession & {
  participants: CollaborationSessionParticipant[]
}

// Event payload types - discriminated union based on event type
type TaskEventPayload = {
  nodeId?: string
  task?: string
  error?: string
  resultPath?: string
  status?: string
  agent?: string
}

type PlanRevisionPayload = {
  revision?: number
}

type ApprovalPayload = {
  kind?: string
  status?: string
}

type DagEventPayload = {
  submittedNodes?: number
  failed?: number
  completed?: number
  summary?: string
  status?: string
}

type SessionStatePayload = {
  from?: string
  to?: string
  status?: string
}

type CollaborationEventPayload =
  | TaskEventPayload
  | PlanRevisionPayload
  | ApprovalPayload
  | DagEventPayload
  | SessionStatePayload
  | Record<string, unknown>

type CollaborationContextEvent = {
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

type CollaborationInteractionResult = CollaborationSessionDetail & {
  event_id?: string | null
  event_sequence?: number | null
  route?: "auto" | "lightweight" | "collaboration"
}

type Project = {
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

type Chat = {
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

type Workspace = {
  id: string
  name: string | null
  workDir: string
  env: Record<string, string>      // 解析后的 JSON
  resources: Record<string, any>   // 解析后的 JSON
  captureThoughts: boolean
  collaborationMode: string
  status: string
  defaultProjectId: string | null  // 默认展示的项目 ID
  projects: WorkspaceProject[]
  createdAt: Date
  updatedAt: Date
}

type WorkspaceProject = {
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

type WorkspaceStatus = {
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

type Conversation = {
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

type Message = {
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
  createdAt: Date
  updatedAt: Date
}

export type ErgataiProject = Project
export type ErgataiWorkspace = Workspace
export type ErgataiWorkspaceProject = WorkspaceProject
export type ErgataiWorkspaceStatus = WorkspaceStatus
export type ErgataiConversation = Conversation
export type ErgataiMessage = Message

type AgentBinding = {
  workspaceId: string
  chatId: string
  agentId: string
  agentName: string
  agentCommand: string | null
  conversationId: string
  createdAt: Date
  updatedAt: Date
}

function mapAgentBinding(binding: BackendAgentBinding): AgentBinding {
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

function mapProject(project: BackendProject): Project {
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

function mapChat(chat: BackendChat): Chat {
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

function mapWorkspace(workspace: BackendWorkspace): Workspace {
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

function mapWorkspaceProject(project: BackendWorkspaceProject): WorkspaceProject {
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
function mapWorkspaceProjectToProject(project: BackendWorkspaceProject): Project {
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

function mapManagedWorkspace(workspace: BackendManagedWorkspace): Workspace {
  const base = mapWorkspace(workspace as unknown as BackendWorkspace)
  return {
    ...base,
    // BackendManagedWorkspace uses string workspace_id, handle default_project_id accordingly
    defaultProjectId: workspace.default_project_id ?? null,
    projects: (workspace.projects ?? []).map(mapWorkspaceProject),
  }
}

function mapWorkspaceStatus(status: BackendWorkspaceStatus): WorkspaceStatus {
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

function parseMessageParts(value: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function parseMessageMetadata(
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

function mapConversation(conversation: BackendConversation): Conversation {
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

function mapMessage(message: BackendMessage): Message {
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
    createdAt: new Date(message.created_at * 1000),
    updatedAt: new Date(message.updated_at * 1000),
  }
}

type LockInfo = {
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

type LockAuditEntry = {
  id: string
  agent_id: string
  file_path: string
  action: string
  mode: string
  timestamp: string
}

type LockContention = {
  file_path: string
  current_holder: string | null
  waiting_agents: string[]
  wait_time_secs: number
  conflict_count: number
}

type MessageTypeStats = {
  message_type: string
  count: number
  percentage: number
}

type DagSubmitResponse = {
  submitted_nodes: number
  progress: number
  graph_status: string
}

type DagValidateResponse = {
  valid: boolean
  errors: string[]
  warnings: string[]
}

type SystemConfig = {
  nats_initialized: boolean
  nats_port: number | null
  active_agents: number
  capture_thoughts: boolean | null
}

// ── Types (mirrored from backend) ──────────────────────────────────────

const AgentInfoSchema = z.object({
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
  config_options: z.any().nullable(),
  profile: z.string().nullable(),
  capabilities: z.array(z.string()),
  state_changed_at: z.string(),
  state_history: z.array(z.any()),
})

const ConversationSummarySchema = z.object({
  id: z.string(),
  agent_a: z.string(),
  agent_b: z.string(),
  state: z.string(),
  message_count: z.number(),
  completed_rounds: z.number(),
  started_at: z.string(),
  last_activity: z.string(),
})

const AgentProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  command: z.string(),
  agent_type: z.string(),
  package_name: z.string().nullable(),
  avatar_url: z.string().nullable(),
  created_at: z.string(),
})

const AgentProfileWithStatusSchema = z.object({
  id: z.string(),
  name: z.string(),
  command: z.string(),
  agent_type: z.string(),
  package_name: z.string().nullable(),
  avatar_url: z.string().nullable(),
  installed: z.boolean(),
  created_at: z.string(),
})

const AgentPlanSchema = z.object({
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
function isValidChatId(chatId: string, procedureName: string): boolean {
  if (!chatId.startsWith("chat_")) {
    console.warn(`[ergatai] ${procedureName}: invalid chatId format:`, chatId)
    return false
  }
  return true
}

// ── Router ─────────────────────────────────────────────────────────────

export const ergataiRouter = router({
  /** List all agents from Ergatai backend */
  listAgents: publicProcedure.query(async () => {
    return ergataiFetch<z.infer<typeof AgentInfoSchema>[]>("/api/v1/agents")
  }),

  /** Get a single agent by ID */
  getAgent: publicProcedure
    .input(z.object({ agentId: agentIdSchema }))
    .query(async ({ input }) => {
      const agents = await ergataiFetch<z.infer<typeof AgentInfoSchema>[]>("/api/v1/agents")
      return agents.find((a) => a.agent_id === input.agentId) ?? null
    }),

  /** Spawn a new agent */
  spawnAgent: publicProcedure
    .input(
      z.object({
        workspaceId: z.string().optional(),
        conversationId: conversationKeySchema.optional(),
        temporaryAgent: z.boolean().optional(),
        command: z.string(),
        instruction: z.string().optional(),
        workDir: z.string().optional(),
        env: z.record(z.string()).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      console.log("[tRPC spawnAgent] Input:", JSON.stringify(input))
      try {
        // Ensure workDir exists - use ~/.ergatai as default if not provided
        let workDir = input.workDir
        if (!workDir) {
          // Use user's home directory instead of /tmp for persistence
          const homeDir = process.env.HOME || process.env.USERPROFILE || tmpdir()
          workDir = join(homeDir, ".ergatai")
          await mkdir(workDir, { recursive: true })
          console.log("[tRPC spawnAgent] Using default workDir:", workDir)
        }

        const response = await ergataiFetch<{
          agent_id?: string
          agentId?: string
        }>("/api/v1/agents", {
          method: "POST",
          body: JSON.stringify({
            workspace_id: input.workspaceId,
            conversation_id: input.conversationId,
            temporary_agent: input.temporaryAgent,
            command: input.command,
            instruction: input.instruction,
            work_dir: workDir,
            env: input.env,
          }),
        })
        console.log("[tRPC spawnAgent] Backend response:", JSON.stringify(response))
        const agentId = response?.agent_id ?? response?.agentId
        if (!agentId) {
          console.error("[tRPC spawnAgent] No agent_id in response. Response was:", response)
          throw new Error("Ergatai backend did not return an agent ID")
        }
        return { agent_id: agentId }
      } catch (error) {
        console.error("[tRPC spawnAgent] Error:", error)
        throw error
      }
    }),

  /** Kill an agent */
  killAgent: publicProcedure
    .input(z.object({ agentId: agentIdSchema }))
    .mutation(async ({ input }) => {
      await ergataiFetch(`/api/v1/agents/${input.agentId}`, {
        method: "DELETE",
      })
      return { success: true }
    }),

  /** Send a message to an agent */
  sendMessage: publicProcedure
    .input(
      z.object({
        agentId: agentIdSchema,
        message: z.string(),
        from: z.string().optional(),
        messageType: z.enum(["request", "response", "broadcast"]).optional(),
        correlationId: z.string().optional(),
        // Agent-to-agent routing fields
        targetAgentCommand: z.string().optional(),  // Target agent type (e.g., "claude", "codex")
        forceNewSession: z.boolean().optional(),    // Force spawn new session
        conversationId: conversationKeySchema.optional(),      // Required for agent-to-agent routing
        clientRequestId: z.string().optional(),    // Frontend-generated ID for optimistic → durable replacement
      }),
    )
    .mutation(async ({ input }) => {
      const body: Record<string, any> = {
        message: input.message,
        from: input.from,
        message_type: input.messageType,
        correlation_id: input.correlationId,
      }

      // Add agent-to-agent routing fields if present
      if (input.targetAgentCommand) {
        body.target_agent_command = input.targetAgentCommand
      }
      if (input.forceNewSession !== undefined) {
        body.force_new_session = input.forceNewSession
      }
      if (input.conversationId) {
        body.conversation_id = input.conversationId
      }
      if (input.clientRequestId) {
        body.client_request_id = input.clientRequestId
      }

      return ergataiFetch(`/api/v1/agents/${input.agentId}/send`, {
        method: "POST",
        body: JSON.stringify(body),
      })
    }),

  /** List root conversations in a workspace */
  listWorkspaceConversations: publicProcedure
    .input(z.object({ workspaceId: z.string() }))
    .query(async ({ input }) => {
      const conversations = await ergataiFetch<BackendConversation[]>(
        `/api/v1/conversations?workspace_id=${encodeURIComponent(input.workspaceId)}`,
      )
      return conversations.map(mapConversation)
    }),

  /** Create a root conversation for a chat */
  createConversation: publicProcedure
    .input(
      z.object({
        chatId: chatIdSchema,
        collaborationSessionId: z.string().optional(),
        title: z.string().optional(),
        mode: z.string().optional(),
        participantRole: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const conversation = await ergataiFetch<BackendConversation>(
        "/api/v1/conversations",
        {
          method: "POST",
          body: JSON.stringify({
            chat_id: input.chatId,
            collaboration_session_id: input.collaborationSessionId,
            name: input.title,
            mode: input.mode,
            participant_role: input.participantRole,
          }),
        },
      )
      return mapConversation(conversation)
    }),

  /** Get a persisted conversation */
  getConversation: publicProcedure
    .input(z.object({ conversationId: conversationKeySchema }))
    .query(async ({ input }) => {
      try {
        const conversation = await ergataiFetch<BackendConversation>(
          `/api/v1/conversations/${encodeURIComponent(input.conversationId)}`,
        )
        return mapConversation(conversation)
      } catch (error) {
        if (isErgataiApiError(error) && error.status === 404) return null
        throw error
      }
    }),

  /** Update a persisted conversation */
  updateConversation: publicProcedure
    .input(
      z.object({
        conversationId: conversationKeySchema,
        title: z.string().optional(),
        mode: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      // Optimization: Skip update if title hasn't changed
      // This avoids redundant database writes when the same title is reported multiple times
      if (input.title !== undefined) {
        try {
          const existing = await ergataiFetch<BackendConversation>(
            `/api/v1/conversations/${encodeURIComponent(input.conversationId)}`,
            { method: "GET" },
          )
          if (existing.name === input.title) {
            // Title unchanged, skip the PATCH request
            return mapConversation(existing)
          }
        } catch {
          // If GET fails, proceed with PATCH (it might create the conversation)
        }
      }

      const conversation = await ergataiFetch<BackendConversation>(
        `/api/v1/conversations/${encodeURIComponent(input.conversationId)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ name: input.title, mode: input.mode }),
        },
      )
      return mapConversation(conversation)
    }),

  /** Delete a persisted conversation */
  deleteConversation: publicProcedure
    .input(z.object({ conversationId: conversationKeySchema }))
    .mutation(async ({ input }) => {
      await ergataiFetch(
        `/api/v1/conversations/${encodeURIComponent(input.conversationId)}`,
        { method: "DELETE" },
      )
      return { success: true }
    }),

  /** Archive a persisted conversation */
  archiveConversation: publicProcedure
    .input(z.object({ conversationId: conversationKeySchema }))
    .mutation(async ({ input }) => {
      const conversation = await ergataiFetch<BackendConversation>(
        `/api/v1/conversations/${encodeURIComponent(input.conversationId)}/archive`,
        { method: "POST" },
      )
      return mapConversation(conversation)
    }),

  /** Unarchive a persisted conversation */
  unarchiveConversation: publicProcedure
    .input(z.object({ conversationId: conversationKeySchema }))
    .mutation(async ({ input }) => {
      const conversation = await ergataiFetch<BackendConversation>(
        `/api/v1/conversations/${encodeURIComponent(input.conversationId)}/unarchive`,
        { method: "POST" },
      )
      return mapConversation(conversation)
    }),

  /** List messages in a conversation */
  listConversationMessages: publicProcedure
    .input(z.object({ conversationId: conversationKeySchema }))
    .query(async ({ input }) => {
      const messages = await ergataiFetch<BackendMessage[]>(
        `/api/v1/conversations/${encodeURIComponent(input.conversationId)}/messages`,
      )
      return messages.map(mapMessage)
    }),

  /**
   * Subscribe to real-time messages in a conversation (SSE)
   * Note: Requires backend to implement GET /api/v1/conversations/{id}/sse
   */
  subscribeConversationMessages: publicProcedure
    .input(
      z.object({
        conversationId: conversationKeySchema,
        afterSequence: z.number().optional(),
      }),
    )
    .subscription(({ input }) => {
      return observable<Message>((emit) => {
        const cleanup = subscribeConversationMessages(
          input.conversationId,
          input.afterSequence,
          (message) => {
            emit.next(mapMessage(message))
          },
          (error) => {
            emit.error(error)
          },
          () => {
            emit.complete()
          },
        )

        return () => {
          cleanup()
        }
      })
    }),

  /** List file changes derived from persisted conversation messages */
  listConversationFileChanges: publicProcedure
    .input(z.object({ conversationId: conversationKeySchema }))
    .query(async ({ input }) => {
      return ergataiFetch<BackendConversationFileChange[]>(
        `/api/v1/conversations/${encodeURIComponent(input.conversationId)}/file-changes`,
      )
    }),

  /** List conversations (替代旧的 runtime/conversations) */
  listConversations: publicProcedure
    .input(z.object({
      workspaceId: z.string().optional(),
      chatId: chatIdSchema.optional(),
      collaborationSessionId: z.string().optional(),
    }).optional())
    .query(async ({ input }) => {
      const params = new URLSearchParams()
      if (input?.workspaceId) params.set("workspace_id", input.workspaceId)
      if (input?.chatId) params.set("chat_id", input.chatId)
      if (input?.collaborationSessionId) params.set("collaboration_session_id", input.collaborationSessionId)
      const query = params.toString() ? `?${params.toString()}` : ""
      const conversations = await ergataiFetch<BackendConversation[]>(`/api/v1/conversations${query}`)
      return conversations.map(mapConversation)
    }),

  /** Get conversation detail (替代旧的 runtime/conversations/{id}) */
  getConversationDetail: publicProcedure
    .input(z.object({ conversationId: conversationKeySchema }))
    .query(async ({ input }) => {
      const conversation = await ergataiFetch<BackendConversation>(`/api/v1/conversations/${encodeURIComponent(input.conversationId)}`)
      return mapConversation(conversation)
    }),

  /** List agent profiles (templates) */
  listProfiles: publicProcedure.query(async () => {
    return ergataiFetch<{ profiles: z.infer<typeof AgentProfileSchema>[] }>("/api/v1/agent-profiles")
  }),

  /** List managed workspaces */
  listManagedWorkspaces: publicProcedure
    .input(
      z.object({
        collaborationMode: z.enum(["supervisor", "group"]).optional(),
      }).optional(),
    )
    .query(async ({ input }) => {
      const query = input?.collaborationMode
        ? `?collaboration_mode=${encodeURIComponent(input.collaborationMode)}`
        : ""
      const workspaces = await ergataiFetch<BackendManagedWorkspace[]>(
        `/api/v1/workspaces/managed${query}`,
      )
      const filteredWorkspaces = input?.collaborationMode
        ? workspaces.filter(
            (workspace) =>
              workspace.collaboration_mode === input.collaborationMode,
          )
        : workspaces
      return filteredWorkspaces.map(mapManagedWorkspace)
    }),

  /** List archived managed workspaces */
  listArchivedWorkspaces: publicProcedure
    .input(
      z.object({
        collaborationMode: z.enum(["supervisor", "group"]).optional(),
      }).optional(),
    )
    .query(async ({ input }) => {
      const query = new URLSearchParams()
      if (input?.collaborationMode) {
        query.set("collaboration_mode", input.collaborationMode)
      }
      query.set("archived", "true")

      const workspaces = await ergataiFetch<BackendManagedWorkspace[]>(
        `/api/v1/workspaces/managed?${query.toString()}`,
      )
      return workspaces.map(mapManagedWorkspace)
    }),

  /** Get a managed workspace by ID */
  getManagedWorkspace: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      try {
        const workspace = await ergataiFetch<BackendManagedWorkspace>(
          `/api/v1/workspaces/managed/${encodeURIComponent(input.id)}`,
          { silentStatus: [404] } // Suppress 404 logs - expected for stale localStorage IDs
        )
        return mapManagedWorkspace(workspace)
      } catch (error) {
        // Return null for 404 errors (workspace no longer exists)
        // This can happen when localStorage has a stale workspace ID
        if (error instanceof ErgataiApiError && error.status === 404) {
          return null
        }
        throw error
      }
    }),

  /** Create a managed workspace */
  createManagedWorkspace: publicProcedure
    .input(
      z.object({
        id: z.string().optional(),
        name: z.string().optional(),
        workDir: z.string(),
        projectId: projectIdSchema.optional(),
        projectPath: z.string().optional(),
        projectName: z.string().optional(),
        env: z.record(z.string()).optional(),
        resources: z.record(z.unknown()).optional(),
        captureThoughts: z.boolean().optional(),
        collaborationMode: z.enum(["supervisor", "group"]).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const workspace = await ergataiFetch<BackendManagedWorkspace>(
        "/api/v1/workspaces/managed",
        {
          method: "POST",
          body: JSON.stringify({
            id: input.id,
            name: input.name,
            work_dir: input.workDir,
            project_id: input.projectId,
            project_path: input.projectPath,
            project_name: input.projectName,
            env: input.env,
            resources: input.resources,
            capture_thoughts: input.captureThoughts ?? false,
            collaboration_mode: input.collaborationMode ?? "supervisor",
          }),
        },
      )
      return mapManagedWorkspace(workspace)
    }),

  /** Update a managed workspace */
  updateManagedWorkspace: publicProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().optional(),
        workDir: z.string().optional(),
        env: z.record(z.string()).optional(),
        resources: z.record(z.unknown()).optional(),
        captureThoughts: z.boolean().optional(),
        status: z.string().optional(),
        defaultProjectId: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const workspace = await ergataiFetch<BackendManagedWorkspace>(
        `/api/v1/workspaces/managed/${encodeURIComponent(input.id)}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            name: input.name,
            work_dir: input.workDir,
            env: input.env,
            resources: input.resources,
            capture_thoughts: input.captureThoughts,
            status: input.status,
            default_project_id: input.defaultProjectId,
          }),
        },
      )
      return mapManagedWorkspace(workspace)
    }),

  /** Set the default project for a workspace (shown on workspace open) */
  setDefaultProject: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        projectId: z.string().nullable(), // null to clear
      }),
    )
    .mutation(async ({ input }) => {
      const workspace = await ergataiFetch<BackendManagedWorkspace>(
        `/api/v1/workspaces/managed/${encodeURIComponent(input.workspaceId)}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            default_project_id: input.projectId,
          }),
        },
      )
      return mapManagedWorkspace(workspace)
    }),

  /** Archive a managed workspace */
  /** Delete a managed workspace */
  deleteManagedWorkspace: publicProcedure
    .input(
      z.object({
        id: z.string(),
        force: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const query = input.force ? "?force=true" : ""
      const status = await ergataiFetch<BackendWorkspaceStatus>(
        `/api/v1/workspaces/managed/${encodeURIComponent(input.id)}/status`,
      )
      if (status.active_agent_count > 0) {
        throw new Error(
          "Workspace has active agents running; stop them before deletion",
        )
      }

      const chats = await ergataiFetch<BackendChat[]>(
        `/api/v1/chats?workspace_id=${encodeURIComponent(input.id)}`,
      )
      const terminalWorkspaceIds = [
        ...new Set(
          chats.flatMap(chat => [chat.id, chat.worktree_path].filter(Boolean) as string[]),
        ),
      ]
      await Promise.all(
        terminalWorkspaceIds.map(id => terminalManager.killByWorkspaceId(id)),
      )

      await ergataiFetch(
        `/api/v1/workspaces/managed/${encodeURIComponent(input.id)}${query}`,
        { method: "DELETE" },
      )
    }),

  /** Archive a managed workspace */
  archiveManagedWorkspace: publicProcedure
    .input(z.object({
      workspaceId: z.string(),
    }))
    .mutation(async ({ input }) => {
      return ergataiFetch(`/api/v1/workspaces/managed/${encodeURIComponent(input.workspaceId)}/archive`, {
        method: "POST",
      })
    }),

  /** Restore a managed workspace */
  restoreManagedWorkspace: publicProcedure
    .input(z.object({
      workspaceId: z.string(),
    }))
    .mutation(async ({ input }) => {
      return ergataiFetch(`/api/v1/workspaces/managed/${encodeURIComponent(input.workspaceId)}/restore`, {
        method: "POST",
      })
    }),

  /** List projects registered in a managed workspace */
  listWorkspaceProjects: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      const projects = await ergataiFetch<BackendWorkspaceProject[]>(
        `/api/v1/workspaces/managed/${encodeURIComponent(input.id)}/projects`,
      )
      return projects.map(mapWorkspaceProject)
    }),

  /** Register a project with a managed workspace */
  registerWorkspaceProject: publicProcedure
    .input(
      z.object({
        id: z.string(),
        projectId: projectIdSchema.optional(),
        projectPath: z.string().optional(),
        projectName: z.string().optional(),
        isDefault: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const workspace = await ergataiFetch<BackendManagedWorkspace>(
        `/api/v1/workspaces/managed/${encodeURIComponent(input.id)}/projects`,
        {
          method: "POST",
          body: JSON.stringify({
            project_id: input.projectId,
            project_path: input.projectPath,
            project_name: input.projectName,
            is_default: input.isDefault ?? false,
          }),
        },
      )
      return mapManagedWorkspace(workspace)
    }),

  /** Remove a project registration from a managed workspace */
  removeWorkspaceProject: publicProcedure
    .input(
      z.object({
        id: z.string(),
        projectId: projectIdSchema,
      }),
    )
    .mutation(async ({ input }) => {
      const workspace = await ergataiFetch<BackendManagedWorkspace>(
        `/api/v1/workspaces/managed/${encodeURIComponent(input.id)}/projects/${encodeURIComponent(input.projectId)}`,
        { method: "DELETE" },
      )
      return mapManagedWorkspace(workspace)
    }),

  /** Get aggregate runtime status for a managed workspace */
  workspaceStatus: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      const status = await ergataiFetch<BackendWorkspaceStatus>(
        `/api/v1/workspaces/managed/${encodeURIComponent(input.id)}/status`,
      )
      const chats = await ergataiFetch<BackendChat[]>(
        `/api/v1/chats?workspace_id=${encodeURIComponent(input.id)}`,
      )
      const terminalWorkspaceIds = [
        ...new Set(
          chats.flatMap(chat => [chat.id, chat.worktree_path].filter(Boolean) as string[]),
        ),
      ]
      const terminalCount = terminalWorkspaceIds.reduce(
        (count, workspaceId) => count + terminalManager.getSessionCountByWorkspaceId(workspaceId),
        0,
      )
      const mapped = mapWorkspaceStatus(status)
      return { ...mapped, terminalCount }
    }),

  /** Get system status */
  getStatus: publicProcedure.query(async () => {
    return ergataiFetch("/api/v1/status")
  }),

  /** Health check */
  healthCheck: publicProcedure.query(async () => {
    try {
      return await ergataiFetch("/health")
    } catch {
      return { status: "unhealthy", error: "Cannot connect to Ergatai backend" }
    }
  }),

  /** List agent profiles with installation status */
  listProfilesWithStatus: publicProcedure.query(async () => {
    return ergataiFetch<{ profiles: z.infer<typeof AgentProfileWithStatusSchema>[] }>(
      "/api/v1/agent-profiles/with-status",
    )
  }),

  /** Install an agent by profile name (npm install -g) */
  installAgent: publicProcedure
    .input(z.object({ name: z.string() }))
    .mutation(async ({ input }) => {
      return ergataiFetch<{ status: string; message: string; output: string }>(
        `/api/v1/agent-profiles/${encodeURIComponent(input.name)}/install`,
        { method: "POST" },
      )
    }),

  /** Uninstall an agent by profile name (npm uninstall -g) */
  uninstallAgent: publicProcedure
    .input(z.object({ name: z.string() }))
    .mutation(async ({ input }) => {
      return ergataiFetch<{ status: string; message: string; output: string }>(
        `/api/v1/agent-profiles/${encodeURIComponent(input.name)}/uninstall`,
        { method: "DELETE" },
      )
    }),

  /** Register a new agent profile */
  registerProfile: publicProcedure
    .input(
      z.object({
        name: z.string(),
        command: z.string(),
        agentType: z.string(),
        packageName: z.string().optional(),
        avatarUrl: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      return ergataiFetch<{ id: string; name: string }>("/api/v1/agent-profiles", {
        method: "POST",
        body: JSON.stringify({
          name: input.name,
          command: input.command,
          agent_type: input.agentType,
          package_name: input.packageName ?? null,
          avatar_url: input.avatarUrl ?? null,
        }),
      })
    }),

  /** Delete an agent profile by ID */
  deleteProfile: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      return ergataiFetch<{ status: string; message: string }>(
        `/api/v1/agent-profiles/${encodeURIComponent(input.id)}`,
        { method: "DELETE" },
      )
    }),

  // ── DAG Endpoints (migrated to Collaboration Sessions) ─────────────────

  /** List all DAGs (now returns collaboration sessions) */
  listDags: publicProcedure.query(async () => {
    // DAG functionality has been migrated to collaboration sessions
    return ergataiFetch("/api/v1/collaboration-sessions")
  }),

  /** Get DAG status (now returns collaboration session detail) */
  getDagStatus: publicProcedure
    .input(z.object({ dagId: z.string() }))
    .query(async ({ input }) => {
      // Use collaboration session detail endpoint
      return ergataiFetch(`/api/v1/collaboration-sessions/${encodeURIComponent(input.dagId)}`)
    }),

  /** Get DAG metrics (now returns collaboration session progress) */
  getDagMetrics: publicProcedure
    .input(z.object({ dagId: z.string() }))
    .query(async ({ input }) => {
      // Use collaboration session progress endpoint
      return ergataiFetch(`/api/v1/collaboration-sessions/${encodeURIComponent(input.dagId)}/progress`)
    }),

  // ── Agent Monitoring Endpoints ──────────────────────────────────────────

  /** Get agent plan */
  getAgentPlan: publicProcedure
    .input(z.object({ agentId: agentIdSchema }))
    .query(async ({ input }): Promise<AgentPlan | null> => {
      try {
        return await ergataiFetch<AgentPlan>(`/api/v1/agents/${input.agentId}/plan`)
      } catch (error) {
        // Return null if plan not found or API error
        return null
      }
    }),

  // ── Projects Endpoints ──────────────────────────────────────────────────
  // Note: Backend projects are workspace-scoped. These endpoints aggregate
  // across all managed workspaces to provide a "standalone" project view.

  /** List all projects (aggregated from all managed workspaces) */
  listProjects: publicProcedure.query(async (): Promise<Project[]> => {
    try {
      // Get all managed workspaces
      const workspaces = await ergataiFetch<BackendManagedWorkspace[]>(
        `/api/v1/workspaces/managed`,
      )
      // Aggregate projects from all workspaces
      const allProjects: Project[] = []
      for (const ws of workspaces) {
        try {
          const projects = await ergataiFetch<BackendWorkspaceProject[]>(
            `/api/v1/workspaces/managed/${encodeURIComponent(ws.workspace_id)}/projects`,
          )
          for (const p of projects) {
            allProjects.push(mapWorkspaceProjectToProject(p))
          }
        } catch (error) {
          // Skip workspaces that no longer exist or have invalid IDs
          console.warn(`[Projects] Failed to list projects for workspace ${ws.workspace_id}:`, error)
        }
      }
      return allProjects
    } catch (error) {
      console.error("[Projects] Failed to list projects:", error)
      return []
    }
  }),

  /** Get a project by ID (searches across all workspaces) */
  getProject: publicProcedure
    .input(z.object({ id: projectIdSchema }))
    .query(async ({ input }): Promise<Project | null> => {
      try {
        const workspaces = await ergataiFetch<BackendManagedWorkspace[]>(
          `/api/v1/workspaces/managed`,
        )
        for (const ws of workspaces) {
          try {
            const projects = await ergataiFetch<BackendWorkspaceProject[]>(
              `/api/v1/workspaces/managed/${encodeURIComponent(ws.workspace_id)}/projects`,
            )
            const found = projects.find((p) => p.project_id === input.id)
            if (found) {
              return mapWorkspaceProjectToProject(found)
            }
          } catch (error) {
            // Skip workspaces that no longer exist or have invalid IDs
            console.warn(`[Projects] Failed to list projects for workspace ${ws.workspace_id}:`, error)
          }
        }
        return null
      } catch (error) {
        console.error("[Projects] Failed to get project:", error)
        return null
      }
    }),

  /** Create workspace - unified API for all workspace creation scenarios */
  createWorkspace: publicProcedure
    .input(
      z.object({
        name: z.string(),
        workDir: z.string(),
        projectId: projectIdSchema.optional(),
        projectPath: z.string().optional(), // If provided and projectId is not, auto-create project
        projectName: z.string().optional(),
        collaborationMode: z.enum(["supervisor", "group"]).optional(),
      }),
    )
    .mutation(async ({ input }): Promise<Workspace> => {
      const collaborationMode = input.collaborationMode ?? "supervisor"

      // Create workspace
      let workspace = await ergataiFetch<BackendManagedWorkspace>(
        "/api/v1/workspaces/managed",
        {
          method: "POST",
          body: JSON.stringify({
            name: input.name,
            work_dir: input.workDir,
            collaboration_mode: collaborationMode,
          }),
        },
      )

      // If projectId is provided, set it as default project
      let didUpdateDefaultProject = false
      if (input.projectId) {
        await ergataiFetch<BackendManagedWorkspace>(
          `/api/v1/workspaces/managed/${encodeURIComponent(workspace.workspace_id)}`,
          {
            method: "PATCH",
            body: JSON.stringify({
              default_project_id: input.projectId,
            }),
          },
        )
        didUpdateDefaultProject = true
      } else if (input.projectPath) {
        // Auto-create project if projectPath is provided
        const project = await ergataiFetch<BackendWorkspaceProject>(
          `/api/v1/workspaces/managed/${encodeURIComponent(workspace.workspace_id)}/projects`,
          {
            method: "POST",
            body: JSON.stringify({
              name: input.projectName || input.name,
              path: input.projectPath,
            }),
          },
        )

        // Validate project_id format before using it
        if (!project.project_id || project.project_id.startsWith('ws_')) {
          console.error('[createWorkspace] Invalid project_id format:', project)
          throw new Error(`Project creation returned invalid project_id: ${project.project_id}`)
        }

        // Set as default project
        await ergataiFetch<BackendManagedWorkspace>(
          `/api/v1/workspaces/managed/${encodeURIComponent(workspace.workspace_id)}`,
          {
            method: "PATCH",
            body: JSON.stringify({
              default_project_id: project.project_id,
            }),
          },
        )
        didUpdateDefaultProject = true
      }

      // Re-fetch workspace once after any default-project update to get the
      // latest defaultProjectId. Previously this was duplicated in both branches.
      if (didUpdateDefaultProject) {
        workspace = await ergataiFetch<BackendManagedWorkspace>(
          `/api/v1/workspaces/managed/${encodeURIComponent(workspace.workspace_id)}`,
          { method: "GET" },
        )
      }

      return mapManagedWorkspace(workspace)
    }),

  /** Create a new project (auto-creates workspace if none exists) */
  createProject: publicProcedure
    .input(
      z.object({
        name: z.string(),
        path: z.string(),
        gitRemoteUrl: z.string().nullish(),
        gitProvider: z.string().nullish(),
        gitOwner: z.string().nullish(),
        gitRepo: z.string().nullish(),
        iconPath: z.string().nullish(),
      }),
    )
    .mutation(async ({ input }): Promise<Project> => {
      let workspaceId: string | null = null
      try {
        const workspaces = await ergataiFetch<BackendManagedWorkspace[]>(
          `/api/v1/workspaces/managed`,
        )
        // Use first existing workspace, or create one named after the project
        if (workspaces.length > 0) {
          workspaceId = workspaces[0]!.workspace_id.toString()
        } else {
          // Auto-create workspace named after the project
          const newWs = await ergataiFetch<BackendManagedWorkspace>(
            `/api/v1/workspaces/managed`,
            {
              method: "POST",
              body: JSON.stringify({
                name: input.name,
                work_dir: input.path,
              }),
            },
          )
          workspaceId = newWs.workspace_id.toString()
        }
      } catch (error) {
        console.error("[Projects] Failed to get/create workspace:", error)
        throw new Error("Failed to get workspace for project")
      }

      // Register the project to the workspace
      try {
        const project = await ergataiFetch<BackendWorkspaceProject>(
          `/api/v1/workspaces/managed/${encodeURIComponent(workspaceId)}/projects`,
          {
            method: "POST",
            body: JSON.stringify({
              name: input.name,
              path: input.path,
              git_remote_url: input.gitRemoteUrl,
              git_provider: input.gitProvider,
              git_owner: input.gitOwner,
              git_repo: input.gitRepo,
              icon_path: input.iconPath,
            }),
          },
        )

        // Set this project as the default project for the workspace
        if (project.project_id) {
          await ergataiFetch<BackendManagedWorkspace>(
            `/api/v1/workspaces/managed/${encodeURIComponent(workspaceId)}`,
            {
              method: "PATCH",
              body: JSON.stringify({
                default_project_id: project.project_id,
              }),
            },
          )
        }

        return mapWorkspaceProjectToProject(project)
      } catch (error) {
        console.error("[Projects] Failed to create project:", error)
        throw new Error(`Failed to create project: ${error instanceof Error ? error.message : String(error)}`)
      }
    }),

  /** Update a project */
  updateProject: publicProcedure
    .input(
      z.object({
        id: projectIdSchema,
        name: z.string().optional(),
        path: z.string().optional(),
        gitRemoteUrl: z.string().nullish(),
        gitProvider: z.string().nullish(),
        gitOwner: z.string().nullish(),
        gitRepo: z.string().nullish(),
        iconPath: z.string().nullish(),
      }),
    )
    .mutation(async ({ input }): Promise<Project | null> => {
      try {
        // Find which workspace contains this project
        const workspaces = await ergataiFetch<BackendManagedWorkspace[]>(
          `/api/v1/workspaces/managed`,
        )
        for (const ws of workspaces) {
          const wsId = ws.workspace_id.toString()
          const projects = await ergataiFetch<BackendWorkspaceProject[]>(
            `/api/v1/workspaces/managed/${encodeURIComponent(wsId)}/projects`,
          )
          const found = projects.find((p) => p.project_id === input.id)
          if (found) {
            // Build update payload (only include fields that are explicitly provided)
            const updatePayload: Record<string, unknown> = {}
            if (input.name !== undefined) updatePayload.name = input.name
            if (input.path !== undefined) updatePayload.path = input.path
            // Git fields: use undefined to skip, null to clear, string to set
            if (input.gitRemoteUrl !== undefined) updatePayload.git_remote_url = input.gitRemoteUrl
            if (input.gitProvider !== undefined) updatePayload.git_provider = input.gitProvider
            if (input.gitOwner !== undefined) updatePayload.git_owner = input.gitOwner
            if (input.gitRepo !== undefined) updatePayload.git_repo = input.gitRepo
            if (input.iconPath !== undefined) updatePayload.icon_path = input.iconPath

            const updated = await ergataiFetch<BackendWorkspaceProject>(
              `/api/v1/workspaces/managed/${encodeURIComponent(wsId)}/projects/${encodeURIComponent(input.id)}`,
              {
                method: "PATCH",
                body: JSON.stringify(updatePayload),
              },
            )
            return mapWorkspaceProjectToProject(updated)
          }
        }
        return null
      } catch (error) {
        console.error("[Projects] Failed to update project:", error)
        return null
      }
    }),

  /** Delete a project (finds workspace and removes) */
  deleteProject: publicProcedure
    .input(z.object({ id: projectIdSchema }))
    .mutation(async ({ input }): Promise<{ success: boolean }> => {
      try {
        const workspaces = await ergataiFetch<BackendManagedWorkspace[]>(
          `/api/v1/workspaces/managed`,
        )
        for (const ws of workspaces) {
          const wsId = ws.workspace_id.toString()
          const projects = await ergataiFetch<BackendWorkspaceProject[]>(
            `/api/v1/workspaces/managed/${encodeURIComponent(wsId)}/projects`,
          )
          const found = projects.find((p) => p.project_id === input.id)
          if (found) {
            await ergataiFetch(
              `/api/v1/workspaces/managed/${encodeURIComponent(wsId)}/projects/${encodeURIComponent(input.id)}`,
              { method: "DELETE" },
            )
            return { success: true }
          }
        }
        return { success: false }
      } catch (error) {
        console.error("[Projects] Failed to delete project:", error)
        return { success: false }
      }
    }),

  // ── Chats Endpoints ─────────────────────────────────────────────────────

  /** List all chats (optionally filtered by workspace) */
  listChats: publicProcedure
    .input(z.object({
      workspaceId: z.string().optional(),
    }).optional())
    .query(async ({ input }) => {
      const params = new URLSearchParams()
      if (input?.workspaceId) params.set('workspace_id', input.workspaceId)
      const query = params.toString() ? `?${params.toString()}` : ""
      const chats = await ergataiFetch<BackendChat[]>(`/api/v1/chats${query}`)
      return chats.map(mapChat)
    }),

  /** Create a new chat */
  createChat: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        name: z.string().optional(),
        collaboration_mode: z.string().optional(),
        worktree_path: z.string().optional(),
        branch: z.string().optional(),
        base_branch: z.string().optional(),
        pr_url: z.string().optional(),
        pr_number: z.number().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const chat = await ergataiFetch<BackendChat>("/api/v1/chats", {
        method: "POST",
        body: JSON.stringify({
          workspace_id: input.workspaceId,
          name: input.name,
          collaboration_mode: input.collaboration_mode,
          worktree_path: input.worktree_path,
          branch: input.branch,
          base_branch: input.base_branch,
          pr_url: input.pr_url,
          pr_number: input.pr_number,
        }),
      })

      const mappedChat = mapChat(chat)
      return {
        ...mappedChat,
        conversations: [],
      }
    }),

  /** Get a chat by ID */
  getChat: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      const chat = await ergataiFetch<BackendChat | null>(`/api/v1/chats/${input.id}`)
      return chat ? mapChat(chat) : null
    }),

  /** Update a chat */
  updateChat: publicProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().optional(),
        collaborationMode: z.string().optional(),
        worktreePath: z.string().nullish(),
        branch: z.string().nullish(),
        baseBranch: z.string().nullish(),
        prUrl: z.string().nullish(),
        prNumber: z.number().int().nullish(),
      }),
    )
    .mutation(async ({ input }) => {
      const { id, ...updates } = input
      const payload: Record<string, unknown> = {}
      if (updates.name !== undefined) payload.name = updates.name
      if (updates.collaborationMode !== undefined) payload.collaboration_mode = updates.collaborationMode
      if (updates.worktreePath !== undefined) payload.worktree_path = updates.worktreePath
      if (updates.branch !== undefined) payload.branch = updates.branch
      if (updates.baseBranch !== undefined) payload.base_branch = updates.baseBranch
      if (updates.prUrl !== undefined) payload.pr_url = updates.prUrl
      if (updates.prNumber !== undefined) payload.pr_number = updates.prNumber

      const chat = await ergataiFetch<BackendChat>(`/api/v1/chats/${id}`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      })
      return mapChat(chat)
    }),

  /** Archive a chat */
  archiveChat: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      await ergataiFetch(`/api/v1/chats/${input.id}/archive`, {
        method: "POST",
      })
      return { success: true }
    }),

  /** Restore a chat */
  unarchiveChat: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      await ergataiFetch(`/api/v1/chats/${input.id}/unarchive`, {
        method: "POST",
      })
      return { success: true }
    }),

  /** Delete a chat */
  deleteChat: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      await ergataiFetch(`/api/v1/chats/${input.id}`, {
        method: "DELETE",
      })
      return { success: true }
    }),

  /** List all agent bindings for a chat (use /agents endpoint) */
  getAgentBindings: publicProcedure
    .input(z.object({ chatId: chatIdSchema }))
    .query(async ({ input }): Promise<AgentBinding[]> => {
      if (!isValidChatId(input.chatId, "getAgentBindings")) {
        return []
      }

      // Use the /agents endpoint to get associated agents
      try {
        const response = await ergataiFetch<{
          agents: Array<{
            agent_id: string
            conversation_id: string
            state: string
            profile: string | null
            last_heartbeat: string
            // Binding creation/update times (Unix seconds). Prefer these over
            // last_heartbeat for createdAt/updatedAt semantics — last_heartbeat
            // reflects agent activity, not when the binding was created.
            created_at?: number
            updated_at?: number
          }>
        }>(`/api/v1/chats/${encodeURIComponent(input.chatId)}/agents`)
        const agents = response.agents
        return agents.map((agent) => {
          // Use binding's created_at/updated_at when available; fall back to
          // last_heartbeat (backwards-compatible with older backend responses).
          // last_heartbeat arrives as an RFC 3339 string; created_at as Unix seconds.
          const createdAtMs = agent.created_at
            ? agent.created_at * 1000
            : Date.parse(agent.last_heartbeat) || Date.now()
          const updatedAtMs = agent.updated_at
            ? agent.updated_at * 1000
            : createdAtMs
          return {
            id: agent.agent_id,
            workspaceId: "",
            chatId: input.chatId,
            agentId: agent.agent_id,
            agentName: agent.profile ?? agent.agent_id,
            agentCommand: agent.profile,
            conversationId: agent.conversation_id ?? "",
            createdAt: new Date(createdAtMs),
            updatedAt: new Date(updatedAtMs),
          }
        })
      } catch (err) {
        console.warn("[ergatai] getAgentBindings failed:", err)
        return []
      }
    }),

  /** Get all agents bound to a chat (for agent-to-agent routing) */
  getChatAgents: publicProcedure
    .input(z.object({ chatId: chatIdSchema }))
    .query(async ({ input }) => {
      if (!isValidChatId(input.chatId, "getChatAgents")) {
        return []
      }

      try {
        const response = await ergataiFetch<{
          agents: Array<{
            agent_id: string
            conversation_id: string
            state: string
            profile: string | null
            last_heartbeat: string
          }>
        }>(`/api/v1/chats/${encodeURIComponent(input.chatId)}/agents`)
        return response.agents
      } catch (err) {
        // Backend endpoint not yet implemented — return empty
        console.warn("[ergatai] getChatAgents failed (backend may not support it yet):", err)
        return []
      }
    }),

  /** Spawn a new agent session (for explicit new session requests) */
  spawnAgentSession: publicProcedure
    .input(
      z.object({
        agentId: agentIdSchema,
        targetCommand: z.string(),
        reason: z.enum(["explicit_request", "context_overflow", "task_separation"]).optional(),
        inheritContext: z.boolean().optional(),
        workspaceId: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      try {
        const result = await ergataiFetch<{
          new_session_id: string
          new_agent_id: string
          message: string
        }>(`/api/v1/agents/${input.agentId}/fork`, {
          method: "POST",
          body: JSON.stringify({
            target_command: input.targetCommand,
            reason: input.reason || "explicit_request",
            inherit_context: input.inheritContext || false,
            workspace_id: input.workspaceId,
          }),
        })
        return result
      } catch (err) {
        console.error("[ergatai] spawnAgentSession failed:", err)
        throw err
      }
    }),

  /** Send a non-blocking prompt and associate it with a conversation */
  promptAgent: publicProcedure
    .input(
      z.object({
        agentId: agentIdSchema,
        message: z.string(),
        conversationId: conversationKeySchema.optional(),
        senderAgentId: z.string().optional(),
        senderAgentName: z.string().optional(),
        images: z
          .array(
            z.object({
              base64Data: z.string(),
              mediaType: z.string(),
              filename: z.string().optional(),
            }),
          )
          .optional(),
        waitForStream: z.boolean().optional(),
        clientRequestId: z.string().optional(),  // Frontend-generated ID for optimistic → durable replacement
      }),
    )
    .mutation(async ({ input }) => {
      return ergataiFetch<{ status: string; prompt_id: string }>(
        `/api/v1/agents/${input.agentId}/prompt`,
        {
          method: "POST",
          body: JSON.stringify({
            message: input.message,
            conversation_id: input.conversationId,
            sender_agent_id: input.senderAgentId,
            sender_agent_name: input.senderAgentName,
            images: input.images ?? [],
            wait_for_stream: input.waitForStream ?? true,
            client_request_id: input.clientRequestId,
          }),
        },
      )
    }),

  /** Cancel an active prompt for an agent */
  cancelPrompt: publicProcedure
    .input(z.object({ agentId: agentIdSchema }))
    .mutation(async ({ input }) => {
      await ergataiFetch(`/api/v1/agents/${input.agentId}/cancel`, {
        method: "POST",
      })
      return { success: true }
    }),

  /** Stream agent output through the main process to avoid browser CORS */
  subscribeAgentStream: publicProcedure
    .input(
      z.object({
        agentId: agentIdSchema,
        promptId: z.string().optional(),
      }),
    )
    .subscription(({ input }) => {
      return observable<AgentOutputEvent>((emit) => {
        return subscribeRawAgentStream(
          input.agentId,
          input.promptId,
          (event) => {
            emit.next(event)
            if (event.type === "done" || event.type === "error") {
              emit.complete()
            }
          },
          (error) => emit.error(error),
          () => emit.complete(),
        )
      })
    }),

  /** Get the backend's live cache for an active conversation turn */
  getConversationRuntime: publicProcedure
    .input(
      z.object({
        conversationId: conversationKeySchema,
        afterSequence: z.number().int().nonnegative().optional(),
      }),
    )
    .query(async ({ input }) => {
      const query = new URLSearchParams()
      if (input.afterSequence !== undefined) {
        query.set("after_sequence", String(input.afterSequence))
      }
      const suffix = query.toString() ? `?${query.toString()}` : ""
      return ergataiFetch<Record<string, unknown>>(
        `/api/v1/conversations/${encodeURIComponent(input.conversationId)}/runtime${suffix}`,
      )
    }),

  /** Stream the backend conversation runtime cache with snapshot + live events */
  subscribeConversationRuntime: publicProcedure
    .input(
      z.object({
        conversationId: conversationKeySchema,
        afterSequence: z.number().int().nonnegative().optional(),
      }),
    )
    .subscription(({ input }) => {
      return observable<ConversationRuntimeStreamEvent>((emit) => {
        return subscribeConversationRuntime(
          input.conversationId,
          input.afterSequence,
          (snapshot) => emit.next({ kind: "snapshot", snapshot }),
          (event) => emit.next({ kind: "event", event }),
          (error) => emit.error(error),
        )
      })
    }),

  // ── Agent Introspection Endpoints ────────────────────────────────────────

  /** Get agent elicitations (pending interactive requests) */
  getAgentElicitations: publicProcedure
    .input(z.object({ agentId: agentIdSchema }))
    .query(async ({ input }) => {
      return ergataiFetch(`/api/v1/agents/${input.agentId}/elicitations`)
    }),

  /** Respond to an agent elicitation */
  respondToElicitation: publicProcedure
    .input(
      z.object({
        agentId: agentIdSchema,
        elicitationId: z.string(),
        response: z.any(),
      }),
    )
    .mutation(async ({ input }) => {
      return ergataiFetch(
        `/api/v1/agents/${input.agentId}/elicitations/${input.elicitationId}/respond`,
        {
          method: "POST",
          body: JSON.stringify(input.response),
        },
      )
    }),

  /** Get pending permission requests (unified approval feed) */
  getPendingPermissions: publicProcedure.query(async () => {
    return ergataiFetch("/api/v1/permissions/pending")
  }),

  /** Respond to a pending permission request */
  respondPermission: publicProcedure
    .input(
      z.object({
        requestId: z.string(),
        decision: z.enum(["allow_once", "allow_always", "reject_once", "reject_always"]),
        formData: z.any().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      return ergataiFetch(
        `/api/v1/permissions/${encodeURIComponent(input.requestId)}/respond`,
        {
          method: "POST",
          body: JSON.stringify({
            decision: input.decision,
            form_data: input.formData,
          }),
        },
      )
    }),

  /** Subscribe to real-time permission lifecycle events */
  subscribePermissions: publicProcedure.subscription(() => {
    return observable<
      | {
          type: "permission_request"
          requestId: string
          kind: "tool" | "mcp-server"
          source: "acp" | "elicitation" | "launch-gate"
          agentId?: string | null
          sessionId?: string | null
          title: string
          toolName?: string | null
          input?: unknown
          locations?: string[]
          createdAtMs: number
        }
      | { type: "permission_resolved"; requestId: string; decision: string }
    >((emit) => {
      const abortController = new AbortController()
      let cleanedUp = false

      const cleanup = () => {
        if (cleanedUp) return
        cleanedUp = true
        abortController.abort()
      }

      const parseEvent = (rawEvent: string): { event: string; data: string } | null => {
        let event = "message"
        const data = rawEvent
          .split("\n")
          .filter((line) => {
            if (line.startsWith("event:")) {
              const value = line.slice(6)
              event = value.startsWith(" ") ? value.slice(1) : value
              return false
            }
            return line.startsWith("data:")
          })
          .map((line) => {
            const value = line.slice(5)
            return value.startsWith(" ") ? value.slice(1) : value
          })
          .join("\n")

        if (!data) return null
        return { event, data }
      }

      void (async () => {
        try {
          const { apiUrl, token } = getErgataiAuthConfig()
          const response = await fetch(`${apiUrl}/api/v1/permissions/stream`, {
            headers: {
              Accept: "text/event-stream",
              Authorization: `Bearer ${token}`,
            },
            signal: abortController.signal,
          })

          if (!response.ok) {
            const detail = await response.text().catch(() => "unknown error")
            throw new Error(`Permission stream failed (${response.status}): ${detail}`)
          }
          if (!response.body) {
            throw new Error("Permission stream response has no readable body")
          }

          const reader = response.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ""

          while (true) {
            const { done, value } = await reader.read()
            if (done) break

            buffer += decoder.decode(value, { stream: true })
            buffer = buffer.replaceAll("\r\n", "\n").replaceAll("\r", "\n")

            while (true) {
              const boundary = buffer.indexOf("\n\n")
              if (boundary === -1) break

              const rawEvent = buffer.slice(0, boundary)
              buffer = buffer.slice(boundary + 2)
              const parsed = parseEvent(rawEvent)
              if (!parsed) continue
              const payload = JSON.parse(parsed.data)
              const type = typeof payload.type === "string" ? payload.type : parsed.event
              if (type === "permission_request" || type === "permission_resolved") {
                emit.next({ ...payload, type })
              }
            }
          }

          emit.complete()
        } catch (err) {
          if (!abortController.signal.aborted) {
            emit.error(err instanceof Error ? err : new Error("Permission stream failed"))
          }
        }
      })()

      return cleanup
    })
  }),

  /** Get the current permission mode (ask | auto | full_access) */
  getPermissionMode: publicProcedure.query(async () => {
    return ergataiFetch("/api/v1/permissions/mode")
  }),

  /** Switch the permission mode */
  setPermissionMode: publicProcedure
    .input(z.object({ mode: z.enum(["ask", "auto", "full_access"]) }))
    .mutation(async ({ input }) => {
      return ergataiFetch("/api/v1/permissions/mode", {
        method: "POST",
        body: JSON.stringify(input),
      })
    }),

  /** Get agent config options */
  getAgentConfigOptions: publicProcedure
    .input(z.object({ agentId: agentIdSchema }))
    .query(async ({ input }) => {
      return ergataiFetch(`/api/v1/agents/${input.agentId}/config-options`)
    }),

  /** Get agent available commands */
  getAgentCommands: publicProcedure
    .input(z.object({ agentId: agentIdSchema }))
    .query(async ({ input }) => {
      return ergataiFetch(`/api/v1/agents/${input.agentId}/commands`)
    }),

  /** Execute an agent command */
  executeAgentCommand: publicProcedure
    .input(
      z.object({
        agentId: agentIdSchema,
        command: z.string(),
        args: z.array(z.string()).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      return ergataiFetch(`/api/v1/agents/${input.agentId}/execute-command`, {
        method: "POST",
        body: JSON.stringify({
          command: input.command,
          args: input.args ?? [],
        }),
      })
    }),

  /** Get latest cached models (no agent required — reads from snapshot store) */
  getLatestCachedModels: publicProcedure.query(async () => {
    const manager = getModelSnapshotManager()
    await manager.initialize()

    // Get the most recent snapshot from the store
    const snapshots = await (await import("../../model-snapshot-store")).loadSnapshots()
    const entries = Object.entries(snapshots)

    if (entries.length === 0) {
      return { models: [], current: undefined }
    }

    // Find the most recently updated snapshot
    const latest = entries.reduce((a, b) =>
      (a[1].timestamp > b[1].timestamp ? a : b)
    )

    return {
      models: latest[1].models,
      current: latest[1].current,
      cacheKey: latest[0],
    }
  }),

  /** Save model snapshot to SQLite cache */
  saveModelSnapshot: publicProcedure
    .input(
      z.object({
        cacheKey: z.string(),
        models: z.array(z.string()),
        current: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const manager = getModelSnapshotManager()
      await manager.saveSnapshot(input.cacheKey, input.models, input.current, false)
      return { success: true }
    }),

  /** Get agent models with cache support */
  getAgentModelsWithCache: publicProcedure
    .input(
      z.object({
        agentId: agentIdSchema,
        forceRefresh: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      // Get agent details
      const agents = await ergataiFetch<z.infer<typeof AgentInfoSchema>[]>("/api/v1/agents")
      const agent = agents.find((a) => a.agent_id === input.agentId)

      if (!agent) {
        throw new Error(`Agent ${input.agentId} not found`)
      }

      // Get model snapshot manager
      const manager = getModelSnapshotManager()

      // Get models with cache support
      const result = await manager.getModelsWithCache(agent, input.forceRefresh)

      return {
        models: result.models,
        current: result.current,
        isCached: result.isCached,
        isStale: result.isStale,
        timestamp: result.timestamp,
      }
    }),

  /** Get agent sessions */
  listAgentSessions: publicProcedure
    .input(z.object({ agentId: agentIdSchema }))
    .query(async ({ input }) => {
      return ergataiFetch(`/api/v1/agents/${input.agentId}/sessions`)
    }),

  /** Create an agent session */
  createAgentSession: publicProcedure
    .input(z.object({ agentId: agentIdSchema }))
    .mutation(async ({ input }) => {
      return ergataiFetch(`/api/v1/agents/${input.agentId}/sessions`, {
        method: "POST",
      })
    }),

  /** Load a specific agent session */
  loadAgentSession: publicProcedure
    .input(z.object({ agentId: agentIdSchema, sessionId: z.string() }))
    .mutation(async ({ input }) => {
      return ergataiFetch(
        `/api/v1/agents/${input.agentId}/sessions/${input.sessionId}`,
        { method: "POST" },
      )
    }),

  /** Delete a specific agent session */
  deleteAgentSession: publicProcedure
    .input(z.object({ agentId: agentIdSchema, sessionId: z.string() }))
    .mutation(async ({ input }) => {
      await ergataiFetch(
        `/api/v1/agents/${input.agentId}/sessions/${input.sessionId}`,
        { method: "DELETE" },
      )
      return { success: true }
    }),

  // ── Lock Monitoring Endpoints ────────────────────────────────────────────

  /** List all active file locks */
  listLocks: publicProcedure.query(async (): Promise<LockInfo[]> => {
    return ergataiFetch<LockInfo[]>("/api/v1/locks")
  }),

  /** Query file lock audit log */
  listLockAudit: publicProcedure
    .input(
      z.object({
        agentId: agentIdSchema.optional(),
        action: z.string().optional(),
        filePath: z.string().optional(),
        limit: z.number().optional(),
      }).optional(),
    )
    .query(async ({ input }): Promise<LockAuditEntry[]> => {
      const params = new URLSearchParams()
      if (input?.agentId) params.set("agent_id", input.agentId)
      if (input?.action) params.set("action", input.action)
      if (input?.filePath) params.set("file_path", input.filePath)
      if (input?.limit) params.set("limit", String(input.limit))
      const query = params.toString()
      return ergataiFetch<LockAuditEntry[]>(
        `/api/v1/locks/audit${query ? `?${query}` : ""}`,
      )
    }),

  /** Get lock contention information */
  getLockContention: publicProcedure.query(async (): Promise<LockContention[]> => {
    return ergataiFetch<LockContention[]>("/api/v1/locks/contention")
  }),

  // ── System Config & Stats Endpoints ─────────────────────────────────────

  /** Get backend system configuration */
  getSystemConfig: publicProcedure.query(async (): Promise<SystemConfig> => {
    return ergataiFetch<SystemConfig>("/api/v1/system/config")
  }),

  // ── DAG Submission & Validation Endpoints (migrated to Collaboration Sessions) ──

  /** Submit a DAG definition for orchestration (now creates collaboration session) */
  submitDag: publicProcedure
    .input(
      z.object({
        definition: z.string(),
        parameters: z.record(z.any()).optional(),
      }),
    )
    .mutation(async ({ input }): Promise<DagSubmitResponse> => {
      // Use collaboration sessions endpoint
      return ergataiFetch<DagSubmitResponse>("/api/v1/collaboration-sessions", {
        method: "POST",
        body: JSON.stringify({
          definition: input.definition,
          parameters: input.parameters ?? undefined,
        }),
      })
    }),

  // ── Implicit Collaboration Runtime Endpoints ────────────────────────────

  /** Find the authoritative collaboration session for a chat */
  findCollaborationSessionByChat: publicProcedure
    .input(z.object({ chatId: chatIdSchema }))
    .query(async ({ input }) => {
      try {
        const sessions = await ergataiFetch<CollaborationSessionDetail[]>(
          `/api/v1/collaboration-sessions?chat_id=${encodeURIComponent(input.chatId)}`,
        )
        return sessions.length > 0 ? sessions[0] : null
      } catch (error) {
        if (isErgataiApiError(error) && error.status === 404) return null
        throw error
      }
    }),

  /** Create or return an authoritative collaboration session */
  createCollaborationSession: publicProcedure
    .input(
      z.object({
        chatId: chatIdSchema,
        workspaceId: z.string().optional(),
        projectId: projectIdSchema.optional(),
        mode: z.enum(["supervisor", "group"]),
        goal: z.string().optional(),
        participants: z
          .array(
            z.object({
              conversationId: conversationKeySchema,
              agentId: agentIdSchema,
              role: z.string().optional(),
              status: z.string().optional(),
            }),
          )
          .optional(),
      }),
    )
    .mutation(async ({ input }) => {
      return ergataiFetch<CollaborationSessionDetail>(
        "/api/v1/collaboration-sessions",
        {
          method: "POST",
          body: JSON.stringify({
            chat_id: input.chatId,
            workspace_id: input.workspaceId,
            project_id: input.projectId,
            mode: input.mode,
            goal: input.goal,
            participants: input.participants?.map((participant) => ({
              conversation_id: participant.conversationId,
              agent_id: participant.agentId,
              role: participant.role,
              status: participant.status,
            })),
          }),
        },
      )
    }),

  /** Submit an interaction to a collaboration session */
  submitCollaborationSessionInteraction: publicProcedure
    .input(
      z.object({
        sessionId: z.string(),
        text: z.string(),
        kind: z.enum(["goal", "message", "input", "artifact"]).optional(),
        mentionedAgentIds: z.array(z.string()).optional(),
        selectedAgentIds: z.array(z.string()).optional(),
        constraints: z.array(z.string()).optional(),
        artifactRefs: z.array(z.string()).optional(),
        metadata: z.record(z.unknown()).optional(),
        route: z.enum(["auto", "lightweight", "collaboration"]).optional(),
        autoExecute: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      return ergataiFetch<CollaborationInteractionResult>(
        `/api/v1/collaboration-sessions/${encodeURIComponent(input.sessionId)}/interactions`,
        {
          method: "POST",
          body: JSON.stringify({
            text: input.text,
            kind: input.kind ?? "message",
            mentioned_agent_ids: input.mentionedAgentIds ?? [],
            selected_agent_ids: input.selectedAgentIds ?? [],
            constraints: input.constraints ?? [],
            artifact_refs: input.artifactRefs ?? [],
            metadata: input.metadata ?? {},
            route: input.route ?? "auto",
            auto_execute: input.autoExecute ?? true,
          }),
        },
      )
    }),

  /** List resumable collaboration session context events */
  listCollaborationSessionEvents: publicProcedure
    .input(
      z.object({
        sessionId: z.string(),
        after: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(500).optional(),
      }),
    )
    .query(async ({ input }) => {
      const query = new URLSearchParams()
      if (input.after !== undefined) query.set("after", String(input.after))
      if (input.limit !== undefined) query.set("limit", String(input.limit))
      const suffix = query.size > 0 ? `?${query.toString()}` : ""
      return ergataiFetch<CollaborationContextEvent[]>(
        `/api/v1/collaboration-sessions/${encodeURIComponent(input.sessionId)}/events${suffix}`,
      )
    }),

  /** Submit a user interaction to a collaboration session */
  submitCollaborationInteraction: publicProcedure
    .input(
      z.object({
        sessionId: z.string(),
        interaction: z.object({
          type: z.literal("message_submitted"),
          chatId: chatIdSchema,
          text: z.string(),
          mentions: z.array(z.string()).optional(),
          workspaceId: z.string().optional(),
        }),
        collaborationMode: z.enum(["supervisor", "group"]),
      }),
    )
    .mutation(async ({ input }) => {
      return ergataiFetch<Record<string, unknown>>(
        `/api/v1/collaboration-sessions/${encodeURIComponent(input.sessionId)}/interactions`,
        {
          method: "POST",
          body: JSON.stringify({
            interaction: input.interaction,
            collaboration_mode: input.collaborationMode,
          }),
        },
      )
    }),

  /** Subscribe to collaboration session events via SSE */
  subscribeCollaborationRuntime: publicProcedure
    .input(z.object({ sessionId: z.string() }))
    .subscription(({ input }) => {
      return observable<CollaborationRuntimeEvent>((emit) => {
        const abortController = new AbortController()
        let cleanedUp = false

        const cleanup = () => {
          if (cleanedUp) return
          cleanedUp = true
          abortController.abort()
        }

        const parseEvent = (rawEvent: string): CollaborationRuntimeEvent | null => {
          const data = rawEvent
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => {
              const value = line.slice(5)
              return value.startsWith(" ") ? value.slice(1) : value
            })
            .join("\n")

          if (!data) return null
          const parsed = JSON.parse(data)
          return parsed && typeof parsed === "object"
            ? (parsed as CollaborationRuntimeEvent)
            : null
        }

        void (async () => {
          try {
            const { apiUrl, token } = getErgataiAuthConfig()
            const response = await fetch(
              `${apiUrl}/api/v1/collaboration-sessions/${encodeURIComponent(input.sessionId)}/stream`,
              {
                headers: {
                  Accept: "text/event-stream",
                  Authorization: `Bearer ${token}`,
                },
                signal: abortController.signal,
              },
            )

            if (!response.ok) {
              const detail = await response.text().catch(() => "unknown error")
              throw new Error(
                `Collaboration session stream failed (${response.status}): ${detail}`,
              )
            }
            if (!response.body) {
              throw new Error("Collaboration session stream has no readable body")
            }

            const reader = response.body.getReader()
            const decoder = new TextDecoder()
            let buffer = ""

            while (true) {
              const { done, value } = await reader.read()
              if (done) break

              buffer += decoder.decode(value, { stream: true })
              buffer = buffer.replaceAll("\r\n", "\n").replaceAll("\r", "\n")

              while (true) {
                const boundary = buffer.indexOf("\n\n")
                if (boundary === -1) break

                const rawEvent = buffer.slice(0, boundary)
                buffer = buffer.slice(boundary + 2)
                const event = parseEvent(rawEvent)
                if (event) emit.next(event)
              }
            }

            emit.complete()
          } catch (error) {
            if (!abortController.signal.aborted) {
              emit.error(
                error instanceof Error
                  ? error
                  : new Error("Collaboration session stream failed"),
              )
            }
          }
        })()

      return cleanup
    })
  }),

  // ── Activity Feed Endpoints ──────────────────────────────────────────────

  /** Get recent activity events */
  getActivity: publicProcedure
    .input(z.object({ limit: z.number().optional() }).optional())
    .query(async ({ input }) => {
      const limit = input?.limit ?? 50
      return ergataiFetch(`/api/v1/activity/recent?limit=${limit}`)
    }),

  /** Subscribe to activity feed events (SSE) */
  subscribeActivity: publicProcedure.subscription(() => {
    return observable<BackendActivityEntry>((emit) => {
      const abortController = new AbortController()
      let cleanedUp = false

      const cleanup = () => {
        if (cleanedUp) return
        cleanedUp = true
        abortController.abort()
      }

      const parseEvent = (rawEvent: string): BackendActivityEntry | null => {
        const data = rawEvent
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => {
            const value = line.slice(5)
            return value.startsWith(" ") ? value.slice(1) : value
          })
          .join("\n")

        if (!data) return null
        return JSON.parse(data) as BackendActivityEntry
      }

      void (async () => {
        try {
          const { apiUrl, token } = getErgataiAuthConfig()
          const response = await fetch(`${apiUrl}/api/v1/activity/stream`, {
            headers: {
              Accept: "text/event-stream",
              Authorization: `Bearer ${token}`,
            },
            signal: abortController.signal,
          })

          if (!response.ok) {
            const detail = await response.text().catch(() => "unknown error")
            throw new Error(`Activity stream failed (${response.status}): ${detail}`)
          }
          if (!response.body) {
            throw new Error("Activity stream response has no readable body")
          }

          const reader = response.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ""

          while (true) {
            const { done, value } = await reader.read()
            if (done) break

            buffer += decoder.decode(value, { stream: true })
            buffer = buffer.replaceAll("\r\n", "\n").replaceAll("\r", "\n")

            while (true) {
              const boundary = buffer.indexOf("\n\n")
              if (boundary === -1) break

              const rawEvent = buffer.slice(0, boundary)
              buffer = buffer.slice(boundary + 2)
              const event = parseEvent(rawEvent)
              if (event) emit.next(event)
            }
          }

          emit.complete()
        } catch (err) {
          if (!abortController.signal.aborted) {
            emit.error(err instanceof Error ? err : new Error("Activity stream failed"))
          }
        }
      })()

      return cleanup
    })
  }),

  // ── Missing Backend API Endpoints (46 total) ─────────────────────────────

  // ── Agent Management (8 endpoints) ─────────────────────────────────────

  /** List suspended agents */
  listSuspendedAgents: publicProcedure.query(async () => {
    return ergataiFetch("/api/v1/agents/suspended")
  }),

  /** Get agent events stream */
  getAgentEvents: publicProcedure
    .input(z.object({ agentId: agentIdSchema }))
    .query(async ({ input }) => {
      return ergataiFetch(`/api/v1/agents/${input.agentId}/events`)
    }),

  /** Send prompt to agent */
  sendPrompt: publicProcedure
    .input(z.object({
      agentId: agentIdSchema,
      prompt: z.string(),
    }))
    .mutation(async ({ input }) => {
      return ergataiFetch(`/api/v1/agents/${input.agentId}/prompt`, {
        method: "POST",
        body: JSON.stringify({ prompt: input.prompt }),
      })
    }),

  /** Resume agent */
  resumeAgent: publicProcedure
    .input(z.object({ agentId: agentIdSchema }))
    .mutation(async ({ input }) => {
      return ergataiFetch(`/api/v1/agents/${input.agentId}/resume`, {
        method: "POST",
      })
    }),

  /** Spawn new agent session */
  spawnNewAgentSession: publicProcedure
    .input(z.object({ agentId: agentIdSchema }))
    .mutation(async ({ input }) => {
      return ergataiFetch(`/api/v1/agents/${input.agentId}/fork`, {
        method: "POST",
      })
    }),

  /** Suspend agent */
  suspendAgent: publicProcedure
    .input(z.object({ agentId: agentIdSchema }))
    .mutation(async ({ input }) => {
      return ergataiFetch(`/api/v1/agents/${input.agentId}/suspend`, {
        method: "POST",
      })
    }),

  // ── Chat Related (3 endpoints) ─────────────────────────────────────────

  /** Lookup worktree for chat */
  lookupChatWorktree: publicProcedure
    .input(z.object({ chatId: chatIdSchema }))
    .query(async ({ input }) => {
      if (!isValidChatId(input.chatId, "lookupChatWorktree")) {
        return null
      }

      return ergataiFetch(`/api/v1/chats/lookup-worktree?chat_id=${encodeURIComponent(input.chatId)}`)
    }),

  /** Get chat agent graph */
  getChatAgentGraph: publicProcedure
    .input(z.object({ chatId: chatIdSchema }))
    .query(async ({ input }) => {
      if (!isValidChatId(input.chatId, "getChatAgentGraph")) {
        return null
      }

      return ergataiFetch(`/api/v1/chats/${encodeURIComponent(input.chatId)}/agent-graph`)
    }),

  /** Get chat agents (alias for existing getChatAgents) */
  getChatAgentsList: publicProcedure
    .input(z.object({ chatId: chatIdSchema }))
    .query(async ({ input }) => {
      if (!isValidChatId(input.chatId, "getChatAgentsList")) {
        return { agents: [] }
      }

      return ergataiFetch(`/api/v1/chats/${encodeURIComponent(input.chatId)}/agents`)
    }),

  // ── Collaboration Sessions (11 endpoints) ───────────────────────────────

  /** Get collaboration session by chat */
  getCollaborationSessionByChat: publicProcedure
    .input(z.object({ chatId: chatIdSchema }))
    .query(async ({ input }) => {
      const sessions = await ergataiFetch<CollaborationSessionDetail[]>(
        `/api/v1/collaboration-sessions?chat_id=${encodeURIComponent(input.chatId)}`,
      )
      return sessions.length > 0 ? sessions[0] : null
    }),

  /** Get collaboration session status */
  getCollaborationSessionStatus: publicProcedure
    .input(z.object({ sessionId: z.string() }))
    .query(async ({ input }) => {
      return ergataiFetch(`/api/v1/collaboration-sessions/${encodeURIComponent(input.sessionId)}/status`)
    }),

  /** Get collaboration session progress */
  getCollaborationSessionProgress: publicProcedure
    .input(z.object({ sessionId: z.string() }))
    .query(async ({ input }) => {
      return ergataiFetch(`/api/v1/collaboration-sessions/${encodeURIComponent(input.sessionId)}/progress`)
    }),

  /** Create collaboration session approval */
  createCollaborationApproval: publicProcedure
    .input(z.object({
      sessionId: z.string(),
      approval: z.any(),
    }))
    .mutation(async ({ input }) => {
      return ergataiFetch(`/api/v1/collaboration-sessions/${encodeURIComponent(input.sessionId)}/approvals`, {
        method: "POST",
        body: JSON.stringify(input.approval),
      })
    }),

  /** Cancel collaboration session */
  cancelCollaborationSession: publicProcedure
    .input(z.object({ sessionId: z.string() }))
    .mutation(async ({ input }) => {
      return ergataiFetch(`/api/v1/collaboration-sessions/${encodeURIComponent(input.sessionId)}/cancel`, {
        method: "POST",
      })
    }),

  /** Update collaboration session state */
  updateCollaborationSessionState: publicProcedure
    .input(z.object({
      sessionId: z.string(),
      state: z.any(),
    }))
    .mutation(async ({ input }) => {
      return ergataiFetch(`/api/v1/collaboration-sessions/${encodeURIComponent(input.sessionId)}/state`, {
        method: "POST",
        body: JSON.stringify(input.state),
      })
    }),

  /** Decide on collaboration approval */
  decideCollaborationApproval: publicProcedure
    .input(z.object({
      sessionId: z.string(),
      approvalId: z.string(),
      decision: z.any(),
    }))
    .mutation(async ({ input }) => {
      return ergataiFetch(`/api/v1/collaboration-sessions/${encodeURIComponent(input.sessionId)}/approvals/${input.approvalId}/decision`, {
        method: "POST",
        body: JSON.stringify(input.decision),
      })
    }),

  /** List collaboration session conversations */
  listCollaborationSessionConversations: publicProcedure
    .input(z.object({
      sessionId: z.string(),
    }))
    .query(async ({ input }) => {
      return ergataiFetch(`/api/v1/collaboration-sessions/${encodeURIComponent(input.sessionId)}/conversations`)
    }),

  /** Get collaboration session conversation */
  getCollaborationSessionConversation: publicProcedure
    .input(z.object({
      sessionId: z.string(),
      conversationId: conversationKeySchema,
    }))
    .query(async ({ input }) => {
      return ergataiFetch(`/api/v1/collaboration-sessions/${encodeURIComponent(input.sessionId)}/conversations/${encodeURIComponent(input.conversationId)}`)
    }),

  /** List collaboration session plans */
  listCollaborationSessionPlans: publicProcedure
    .input(z.object({
      sessionId: z.string(),
    }))
    .query(async ({ input }) => {
      return ergataiFetch(`/api/v1/collaboration-sessions/${encodeURIComponent(input.sessionId)}/plans`)
    }),

  /** Get collaboration session plan */
  getCollaborationSessionPlan: publicProcedure
    .input(z.object({
      sessionId: z.string(),
      planId: z.string(),
    }))
    .query(async ({ input }) => {
      return ergataiFetch(`/api/v1/collaboration-sessions/${encodeURIComponent(input.sessionId)}/plans/${encodeURIComponent(input.planId)}`)
    }),

  /** Execute collaboration session plan */
  executeCollaborationSessionPlan: publicProcedure
    .input(z.object({
      sessionId: z.string(),
      planId: z.string(),
    }))
    .mutation(async ({ input }) => {
      return ergataiFetch(`/api/v1/collaboration-sessions/${encodeURIComponent(input.sessionId)}/plans/${encodeURIComponent(input.planId)}/execute`, {
        method: "POST",
      })
    }),

  /** Get collaboration session events */
  getCollaborationSessionEvents: publicProcedure
    .input(z.object({
      sessionId: z.string(),
    }))
    .query(async ({ input }) => {
      return ergataiFetch(`/api/v1/collaboration-sessions/${encodeURIComponent(input.sessionId)}/events`)
    }),

  /** Subscribe to collaboration session stream */
  subscribeCollaborationSessionStream: publicProcedure
    .input(z.object({ sessionId: z.string() }))
    .subscription(({ input }) => {
      return observable<any>((emit) => {
        const abortController = new AbortController()
        let cleanedUp = false

        const cleanup = () => {
          if (cleanedUp) return
          cleanedUp = true
          abortController.abort()
        }

        const parseEvent = (rawEvent: string): any | null => {
          const data = rawEvent
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => {
              const value = line.slice(5)
              return value.startsWith(" ") ? value.slice(1) : value
            })
            .join("\n")

          if (!data) return null
          const parsed = JSON.parse(data)
          return parsed && typeof parsed === "object" ? parsed : null
        }

        void (async () => {
          try {
            const { apiUrl, token } = getErgataiAuthConfig()
            const response = await fetch(
              `${apiUrl}/api/v1/collaboration-sessions/${encodeURIComponent(input.sessionId)}/stream`,
              {
                headers: {
                  Accept: "text/event-stream",
                  Authorization: `Bearer ${token}`,
                },
                signal: abortController.signal,
              },
            )

            if (!response.ok) {
              const detail = await response.text().catch(() => "unknown error")
              throw new Error(`Session stream failed (${response.status}): ${detail}`)
            }
            if (!response.body) {
              throw new Error("Session stream has no readable body")
            }

            const reader = response.body.getReader()
            const decoder = new TextDecoder()
            let buffer = ""

            while (true) {
              const { done, value } = await reader.read()
              if (done) break

              buffer += decoder.decode(value, { stream: true })
              buffer = buffer.replaceAll("\r\n", "\n").replaceAll("\r", "\n")

              while (true) {
                const boundary = buffer.indexOf("\n\n")
                if (boundary === -1) break

                const rawEvent = buffer.slice(0, boundary)
                buffer = buffer.slice(boundary + 2)
                const event = parseEvent(rawEvent)
                if (event) emit.next(event)
              }
            }

            emit.complete()
          } catch (error) {
            if (!abortController.signal.aborted) {
              emit.error(error instanceof Error ? error : new Error("Session stream failed"))
            }
          }
        })()

        return cleanup
      })
    }),

  // ── Conversation Related (5 endpoints) ─────────────────────────────────

  /** Get conversation outputs */
  getConversationOutputs: publicProcedure
    .input(z.object({ conversationId: conversationKeySchema }))
    .query(async ({ input }) => {
      return ergataiFetch(`/api/v1/conversations/${encodeURIComponent(input.conversationId)}/outputs`)
    }),

  /** Get specific conversation output */
  getConversationOutput: publicProcedure
    .input(z.object({
      conversationId: conversationKeySchema,
      outputId: z.string(),
    }))
    .query(async ({ input }) => {
      return ergataiFetch(`/api/v1/conversations/${encodeURIComponent(input.conversationId)}/outputs/${encodeURIComponent(input.outputId)}`)
    }),

  /** Get conversation file changes */
  getConversationFileChanges: publicProcedure
    .input(z.object({ conversationId: conversationKeySchema }))
    .query(async ({ input }) => {
      return ergataiFetch(`/api/v1/conversations/${encodeURIComponent(input.conversationId)}/file-changes`)
    }),

  // ── Terminal Sessions (9 endpoints) ────────────────────────────────────

  /** List all terminal sessions */
  listTerminalSessions: publicProcedure.query(async () => {
    return ergataiFetch("/api/v1/terminal-sessions")
  }),

  /** Create terminal session */
  createTerminalSession: publicProcedure
    .input(z.object({
      workspaceId: z.string(),
      command: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      return ergataiFetch("/api/v1/terminal-sessions", {
        method: "POST",
        body: JSON.stringify(input),
      })
    }),

  /** Get terminal session details */
  getTerminalSession: publicProcedure
    .input(z.object({ sessionId: z.string() }))
    .query(async ({ input }) => {
      return ergataiFetch(`/api/v1/terminal-sessions/${encodeURIComponent(input.sessionId)}`)
    }),

  /** Stream terminal output */
  streamTerminalOutput: publicProcedure
    .input(z.object({ sessionId: z.string() }))
    .subscription(({ input }) => {
      return observable<any>((emit) => {
        const abortController = new AbortController()
        let cleanedUp = false

        const cleanup = () => {
          if (cleanedUp) return
          cleanedUp = true
          abortController.abort()
        }

        const parseEvent = (rawEvent: string): any | null => {
          const data = rawEvent
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => {
              const value = line.slice(5)
              return value.startsWith(" ") ? value.slice(1) : value
            })
            .join("\n")

          if (!data) return null
          const parsed = JSON.parse(data)
          return parsed && typeof parsed === "object" ? parsed : null
        }

        void (async () => {
          try {
            const { apiUrl, token } = getErgataiAuthConfig()
            const response = await fetch(
              `${apiUrl}/api/v1/terminal-sessions/${encodeURIComponent(input.sessionId)}/stream`,
              {
                headers: {
                  Accept: "text/event-stream",
                  Authorization: `Bearer ${token}`,
                },
                signal: abortController.signal,
              },
            )

            if (!response.ok) {
              const detail = await response.text().catch(() => "unknown error")
              throw new Error(`Terminal stream failed (${response.status}): ${detail}`)
            }
            if (!response.body) {
              throw new Error("Terminal stream has no readable body")
            }

            const reader = response.body.getReader()
            const decoder = new TextDecoder()
            let buffer = ""

            while (true) {
              const { done, value } = await reader.read()
              if (done) break

              buffer += decoder.decode(value, { stream: true })
              buffer = buffer.replaceAll("\r\n", "\n").replaceAll("\r", "\n")

              while (true) {
                const boundary = buffer.indexOf("\n\n")
                if (boundary === -1) break

                const rawEvent = buffer.slice(0, boundary)
                buffer = buffer.slice(boundary + 2)
                const event = parseEvent(rawEvent)
                if (event) emit.next(event)
              }
            }

            emit.complete()
          } catch (error) {
            if (!abortController.signal.aborted) {
              emit.error(error instanceof Error ? error : new Error("Terminal stream failed"))
            }
          }
        })()

        return cleanup
      })
    }),

  /** Send input to terminal */
  sendTerminalInput: publicProcedure
    .input(z.object({
      sessionId: z.string(),
      input: z.string(),
    }))
    .mutation(async ({ input }) => {
      return ergataiFetch(`/api/v1/terminal-sessions/${encodeURIComponent(input.sessionId)}/input`, {
        method: "POST",
        body: JSON.stringify({ input: input.input }),
      })
    }),

  /** Resize terminal */
  resizeTerminal: publicProcedure
    .input(z.object({
      sessionId: z.string(),
      cols: z.number(),
      rows: z.number(),
    }))
    .mutation(async ({ input }) => {
      return ergataiFetch(`/api/v1/terminal-sessions/${encodeURIComponent(input.sessionId)}/resize`, {
        method: "POST",
        body: JSON.stringify({ cols: input.cols, rows: input.rows }),
      })
    }),

  /** Send signal to terminal */
  signalTerminal: publicProcedure
    .input(z.object({
      sessionId: z.string(),
      signal: z.string(),
    }))
    .mutation(async ({ input }) => {
      return ergataiFetch(`/api/v1/terminal-sessions/${encodeURIComponent(input.sessionId)}/signal`, {
        method: "POST",
        body: JSON.stringify({ signal: input.signal }),
      })
    }),

  /** Terminate terminal */
  terminateTerminal: publicProcedure
    .input(z.object({ sessionId: z.string() }))
    .mutation(async ({ input }) => {
      return ergataiFetch(`/api/v1/terminal-sessions/${encodeURIComponent(input.sessionId)}/terminate`, {
        method: "POST",
      })
    }),

  /** Get terminal audit log */
  getTerminalAudit: publicProcedure
    .input(z.object({ sessionId: z.string() }))
    .query(async ({ input }) => {
      return ergataiFetch(`/api/v1/terminal-sessions/${encodeURIComponent(input.sessionId)}/audit`)
    }),

  // ── Other (3 endpoints) ────────────────────────────────────────────────

  /** Get locks audit log */
  getLocksAudit: publicProcedure.query(async () => {
    return ergataiFetch("/api/v1/locks/audit")
  }),

  /** Subscribe to permissions stream */
  subscribePermissionsStream: publicProcedure.subscription(() => {
    return observable<any>((emit) => {
      const abortController = new AbortController()
      let cleanedUp = false

      const cleanup = () => {
        if (cleanedUp) return
        cleanedUp = true
        abortController.abort()
      }

      const parseEvent = (rawEvent: string): any | null => {
        const data = rawEvent
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => {
            const value = line.slice(5)
            return value.startsWith(" ") ? value.slice(1) : value
          })
          .join("\n")

        if (!data) return null
        const parsed = JSON.parse(data)
        return parsed && typeof parsed === "object" ? parsed : null
      }

      void (async () => {
        try {
          const { apiUrl, token } = getErgataiAuthConfig()
          const response = await fetch(`${apiUrl}/api/v1/permissions/stream`, {
            headers: {
              Accept: "text/event-stream",
              Authorization: `Bearer ${token}`,
            },
            signal: abortController.signal,
          })

          if (!response.ok) {
            const detail = await response.text().catch(() => "unknown error")
            throw new Error(`Permissions stream failed (${response.status}): ${detail}`)
          }
          if (!response.body) {
            throw new Error("Permissions stream has no readable body")
          }

          const reader = response.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ""

          while (true) {
            const { done, value } = await reader.read()
            if (done) break

            buffer += decoder.decode(value, { stream: true })
            buffer = buffer.replaceAll("\r\n", "\n").replaceAll("\r", "\n")

            while (true) {
              const boundary = buffer.indexOf("\n\n")
              if (boundary === -1) break

              const rawEvent = buffer.slice(0, boundary)
              buffer = buffer.slice(boundary + 2)
              const event = parseEvent(rawEvent)
              if (event) emit.next(event)
            }
          }

          emit.complete()
        } catch (error) {
          if (!abortController.signal.aborted) {
            emit.error(error instanceof Error ? error : new Error("Permissions stream failed"))
          }
        }
      })()

      return cleanup
    })
  }),

  /** Respond to permission request */
  respondToPermission: publicProcedure
    .input(z.object({
      permissionId: z.string(),
      response: z.any(),
    }))
    .mutation(async ({ input }) => {
      return ergataiFetch(`/api/v1/permissions/${encodeURIComponent(input.permissionId)}/respond`, {
        method: "POST",
        body: JSON.stringify(input.response),
      })
    }),
})
