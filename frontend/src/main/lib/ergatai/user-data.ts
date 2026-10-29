import { ergataiFetch, isErgataiApiError } from "./api"

export type BackendProject = {
  id: string
  name: string
  path: string
  git_remote_url: string | null
  git_provider: string | null
  git_owner: string | null
  git_repo: string | null
  icon_path: string | null
  created_at: number
  updated_at: number
}

export type BackendWorkspace = {
  workspace_id: string  // Backend returns formatted string like "ws_123_000_0000"
  name: string | null
  work_dir: string
  env: string           // JSON string
  resources: string     // JSON string
  config: string        // JSON string
  collaboration_mode: string
  status: string
  default_project_id: string | null  // Backend returns formatted string like "proj_123_000_0000"
  created_at: number    // Unix timestamp (seconds)
  updated_at: number    // Unix timestamp (seconds)
}

/**
 * Workspace project with denormalized project details.
 * Note: This corresponds to backend's Project struct returned by
 * workspace project endpoints.
 */
export type BackendWorkspaceProject = {
  workspace_id: string
  project_id: string
  name: string
  path: string
  description: string | null
  git_remote_url: string | null
  git_provider: string | null
  git_owner: string | null
  git_repo: string | null
  icon_path: string | null
  created_at: number
  updated_at: number
}

export type BackendManagedWorkspace = {
  workspace_id: string  // Backend returns formatted string like "ws_123_000_0000"
  name: string | null
  work_dir: string
  env: string
  resources: string
  config: string
  collaboration_mode: string
  status: string
  default_project_id: string | null
  created_at: number
  updated_at: number
  projects?: BackendWorkspaceProject[]  // 可选字段，后端可能不返回
}

export type BackendWorkspaceStatus = {
  workspace_id: string
  status: string
  work_dir: string
  work_dir_exists: boolean
  project_count: number
  active_agent_count: number
  conversation_count: number
  active_conversation_count: number
  worktree_count: number
  dirty_worktree_count: number
  healthy: boolean
}

export type ManagedWorkspaceStatus = {
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

// Matches OpenAPI ChatResponse schema
export type BackendChat = {
  id: string
  workspace_id: string
  name: string | null
  collaboration_mode: string | null
  created_at: number
  updated_at: number
  archived_at: number | null
  worktree_path: string | null
  branch: string | null
  base_branch: string | null
  pr_url: string | null
  pr_number: number | null
}


export type BackendAgentBinding = {
  workspace_id: string
  chat_id: string
  agent_id: string
  agent_name: string
  agent_command: string | null
  conversation_id: string
  created_at: number
  updated_at: number
}

export type AgentPlan = {
  plan_id: string
  file_path: string
  status: "active" | "archived" | "none"
  content: string
  created_at: number
  updated_at: number
}

// Matches OpenAPI ConversationResponse schema
export type BackendConversation = {
  id: string
  collaboration_session_id: string
  chat_id: string
  parent_id: string | null
  name: string | null
  mode: string
  participant_role: string
  status: string
  created_at: number
  updated_at: number
}

// Matches OpenAPI Message schema
export type BackendMessage = {
  message_id: string
  conversation_id: string
  sequence: number
  role: string
  parts: string           // JSON string
  metadata: string | null // JSON string
  // Agent消息专用字段（新增）
  from_agent_id: string | null
  from_agent_name: string | null
  message_type: string | null
  content: string | null
  turn_id: string | null
  projection_kind: string | null
  origin_message_id: string | null
  created_at: number
  updated_at: number
}

export type BackendInitialPromptTurn = {
  turnId: string
  conversationId: string
  chatId: string
  workspaceId: string
  messageId: string
  clientRequestId: string
  agentCommand: string
  prompt: string
  images: Array<{
    base64Data: string
    mediaType: string
    filename: string | null
  }>
  status: "pending" | "dispatching" | "running" | "completed" | "failed"
  attempt: number
  error: string | null
  createdAt: number
  updatedAt: number
  dispatchedAt: number | null
  completedAt: number | null
}

function parseJsonOr<T>(value: string | null | undefined, fallback: T): T {
  if (value == null) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function unwrapAgentEnvelopeText(value: string | null | undefined): string | undefined {
  if (!value) return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    if (
      parsed &&
      typeof parsed === "object" &&
      "message" in parsed &&
      typeof (parsed as { message?: unknown }).message === "string"
    ) {
      return (parsed as { message: string }).message
    }
  } catch {
    // Plain text
  }
  return undefined
}

function normalizePersistedMessageParts(
  message: BackendMessage,
): unknown[] {
  const parts = parseJsonOr<unknown[]>(message.parts, [])
  const structuredContent = unwrapAgentEnvelopeText(message.content) ??
    (message.content?.trim() ? message.content : undefined)

  // Inter-agent requests/responses store the original wire envelope in parts
  // and the human-readable message in `content`. Normalizing here prevents the
  // renderer from showing `{"from":"...", "message":"..."}` as assistant text.
  const isEnvelopeCandidate =
    message.role === "agent" || Boolean(message.message_type)
  const hasTextOnlyParts =
    parts.length > 0 &&
    parts.every((part) => {
      const candidate = part as { type?: unknown }
      return candidate?.type === "text"
    })

  if (structuredContent && isEnvelopeCandidate && hasTextOnlyParts) {
    return [{ type: "text", text: structuredContent }]
  }

  return parts
}

/**
 * Normalize a backend message into the UI message shape.
 *
 * Backend messages use `message_id`, `from_agent_id`, etc. UI components and
 * the optimized message cache consistently key on `id`, `fromAgentId`, etc.
 * Every API boundary returning BackendMessage to the renderer should use this.
 */
export function mapBackendMessageToUiMessage(message: BackendMessage) {
  const parts = normalizePersistedMessageParts(message)

  return {
    id: String(message.message_id),
    conversationId: String(message.conversation_id),
    sequence: message.sequence,
    role: message.role,
    parts,
    metadata: parseJsonOr<Record<string, unknown> | null>(message.metadata, null),
    fromAgentId: message.from_agent_id ?? undefined,
    fromAgentName: message.from_agent_name ?? undefined,
    messageType: message.message_type ?? undefined,
    content: message.content ?? undefined,
    turnId: message.turn_id ?? undefined,
    projectionKind: message.projection_kind ?? undefined,
    originMessageId: message.origin_message_id ?? undefined,
    createdAt: message.created_at,
    updatedAt: message.updated_at,
  }
}

export function mapBackendMessagesToUiMessages(messages: BackendMessage[]) {
  return messages.map(mapBackendMessageToUiMessage)
}

/**
 * SSE 消息格式（后端 ConversationMessagePayload）
 * 与 REST API 的 BackendMessage 不同，需要在客户端转换
 */
export type BackendSseMessage = {
  conversation_id: string
  message_id: string
  role: string
  content: string
  parts: unknown
  metadata: unknown | null
  timestamp: number
  sequence: number
  sender_agent_id?: string
  sender_agent_name?: string
  message_type?: string
  turn_id?: string | null
  projection_kind?: string | null
  origin_message_id?: string | null
}

export type RegisteredWorktree = {
  chat: BackendChat | null
  projectPath: string | null
}

const REGISTERED_WORKTREE_CACHE_TTL_MS = 15_000
const registeredWorktreeCache = new Map<
  string,
  { promise: Promise<RegisteredWorktree | null>; expiresAt: number }
>()

export async function listProjects(): Promise<BackendProject[]> {
  return ergataiFetch<BackendProject[]>("/api/v1/projects")
}

export async function getProject(id: string): Promise<BackendProject | null> {
  try {
    return await ergataiFetch<BackendProject>(`/api/v1/projects/${encodeURIComponent(id)}`)
  } catch (error) {
    if (isErgataiApiError(error) && error.status === 404) {
      return null
    }
    throw error
  }
}

export async function listChats(workspaceId?: string): Promise<BackendChat[]> {
  const query = workspaceId ? `?workspace_id=${encodeURIComponent(workspaceId)}` : ""
  return ergataiFetch<BackendChat[]>(`/api/v1/chats${query}`)
}

export async function updateChat(
  id: string,
  patch: Partial<{
    name: string
    collaboration_mode: string | null
    worktree_path: string | null
    branch: string | null
    base_branch: string | null
    pr_url: string | null
    pr_number: number | null
  }>,
): Promise<BackendChat> {
  return ergataiFetch<BackendChat>(`/api/v1/chats/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  })
}

export async function deleteChat(id: string): Promise<void> {
  await ergataiFetch(`/api/v1/chats/${encodeURIComponent(id)}`, { method: "DELETE" })
}

export async function deleteProject(id: string): Promise<void> {
  await ergataiFetch(`/api/v1/projects/${encodeURIComponent(id)}`, { method: "DELETE" })
}

export async function listConversations(chatId: string): Promise<BackendConversation[]> {
  return ergataiFetch<BackendConversation[]>(
    `/api/v1/conversations?chat_id=${encodeURIComponent(chatId)}`,
  )
}

export async function updateConversationMessages(
  id: string,
  messages: Array<Record<string, unknown>>,
): Promise<BackendMessage[]> {
  const persistedMessages = await ergataiFetch<BackendMessage[]>(
    `/api/v1/conversations/${encodeURIComponent(id)}/messages`,
    { method: "POST", body: JSON.stringify({ messages }) },
  )
  return persistedMessages
}

export async function createConversation(
  chatId: string,
  input: { name?: string; mode?: string; sessionId?: string },
): Promise<BackendConversation> {
  return createChildConversation(chatId, { name: input.name, mode: input.mode, sessionId: input.sessionId })
}

export async function getRegisteredWorktree(
  path: string,
): Promise<RegisteredWorktree | null> {
  const cached = registeredWorktreeCache.get(path)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.promise
  }

  const promise = (async () => {
    // Single API call — backend does prefix matching on projects.path and chats.worktree_path
    const result = await ergataiFetch<{
      project?: BackendWorkspaceProject
      chat?: BackendChat
    }>(`/api/v1/registered-path?path=${encodeURIComponent(path)}`)

    return {
      chat: result.chat || null,
      projectPath: result.project?.path || null,
    }
  })()

  registeredWorktreeCache.set(path, {
    promise,
    expiresAt: Date.now() + REGISTERED_WORKTREE_CACHE_TTL_MS,
  })
  promise.catch(() => registeredWorktreeCache.delete(path))
  return promise
}

// ── Conversation APIs ──

export async function listWorkspaceConversations(
  workspaceId: string,
): Promise<BackendConversation[]> {
  return ergataiFetch<BackendConversation[]>(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/conversations`,
  )
}

export async function createWorkspaceConversation(
  workspaceId: string,
  input: { name?: string; mode?: string },
): Promise<BackendConversation> {
  return ergataiFetch<BackendConversation>(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/conversations`,
    { method: "POST", body: JSON.stringify(input) },
  )
}

export async function getConversation(
  id: string,
): Promise<BackendConversation | null> {
  try {
    return await ergataiFetch<BackendConversation>(
      `/api/v1/conversations/${encodeURIComponent(id)}`,
    )
  } catch (error) {
    if (isErgataiApiError(error) && error.status === 404) return null
    throw error
  }
}

export async function listChildConversations(
  conversationId: string,
): Promise<BackendConversation[]> {
  return ergataiFetch<BackendConversation[]>(
    `/api/v1/conversations/${encodeURIComponent(conversationId)}/children`,
  )
}

export async function createChildConversation(
  conversationId: string,
  input: { name?: string; mode?: string; sessionId?: string },
): Promise<BackendConversation> {
  return ergataiFetch<BackendConversation>(
    `/api/v1/conversations/${encodeURIComponent(conversationId)}/children`,
    { method: "POST", body: JSON.stringify(input) },
  )
}

export async function archiveConversation(id: string): Promise<BackendConversation> {
  return ergataiFetch<BackendConversation>(
    `/api/v1/conversations/${encodeURIComponent(id)}/archive`,
    { method: "POST" },
  )
}

export async function unarchiveConversation(id: string): Promise<BackendConversation> {
  return ergataiFetch<BackendConversation>(
    `/api/v1/conversations/${encodeURIComponent(id)}/unarchive`,
    { method: "POST" },
  )
}

export async function updateConversation(
  id: string,
  patch: { name?: string; mode?: string },
): Promise<BackendConversation> {
  return ergataiFetch<BackendConversation>(
    `/api/v1/conversations/${encodeURIComponent(id)}`,
    { method: "PATCH", body: JSON.stringify(patch) },
  )
}

export async function deleteConversation(id: string): Promise<void> {
  await ergataiFetch(`/api/v1/conversations/${encodeURIComponent(id)}`, {
    method: "DELETE",
  })
}

export async function listConversationMessages(
  conversationId: string,
): Promise<BackendMessage[]> {
  return ergataiFetch<BackendMessage[]>(
    `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages`,
  )
}

export async function appendConversationMessage(
  conversationId: string,
  input: {
    role: string
    text?: string
    parts?: unknown
    metadata?: unknown
  },
): Promise<BackendMessage> {
  return ergataiFetch<BackendMessage>(
    `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages`,
    { method: "POST", body: JSON.stringify(input) },
  )
}

export async function replaceConversationMessages(
  conversationId: string,
  messages: Array<Record<string, unknown>>,
): Promise<BackendMessage[]> {
  return ergataiFetch<BackendMessage[]>(
    `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages`,
    { method: "PUT", body: JSON.stringify({ messages }) },
  )
}

export async function createInitialPromptTurn(
  conversationId: string,
  input: {
    messageId: string
    clientRequestId: string
    agentCommand: string
    prompt: string
    images: Array<{
      base64Data: string
      mediaType: string
      filename: string | null
    }>
  },
): Promise<BackendInitialPromptTurn> {
  return ergataiFetch<BackendInitialPromptTurn>(
    `/api/v1/conversations/${encodeURIComponent(conversationId)}/initial-prompt`,
    { method: "POST", body: JSON.stringify(input) },
  )
}
