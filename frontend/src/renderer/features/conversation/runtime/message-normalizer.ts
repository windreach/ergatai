/**
 * Unified Message Normalizer
 *
 * 将三个数据源（persisted API、runtime SSE、local stream）的消息统一转换为
 * 一致的 Message 对象，确保 metadata 完全相同。
 *
 * 设计原则：
 * 1. 所有数据源都来自后端，应该携带相同的元数据
 * 2. 不同的传输格式（API/SSE/stream）需要不同的解析逻辑
 * 3. 但最终输出的 Message 对象应该完全一致
 *
 * 统一的 metadata 字段：
 * - turnId: 后端分配的 turn 标识符（用于去重）
 * - agentContent: agent 消息的结构化内容
 * - senderAgentId: 发送者 agent ID
 * - senderAgentName: 发送者 agent 名称
 * - messageType: 消息类型 (request/response/broadcast)
 * - fromAgentId: 来源 agent ID（A2A 消息）
 * - fromAgentName: 来源 agent 名称（A2A 消息）
 */

import type { Message, MessageRole, MessagePart } from "../../agents/stores/message-store"
import type { AgentMessageMetadata } from "../../agents/ui/agent-message-usage"

/**
 * 后端 API 返回的消息格式（tRPC router 返回）
 */
export interface BackendApiMessage {
  id: string
  role: "user" | "assistant" | "agent"
  content: string
  senderAgentId?: string | null
  senderAgentName?: string | null
  fromAgentId?: string | null
  fromAgentName?: string | null
  messageType?: string | null
  turnId?: string | null
  agentContent?: string | null
  metadata?: Record<string, unknown>
  parts?: unknown[]
  createdAt?: string | number | Date
}

/**
 * Runtime SSE 事件格式（conversation_message 事件）
 */
export interface RuntimeSSEEvent {
  message_id: string
  role: string
  content: string
  sender_agent_id?: string | null
  sender_agent_name?: string | null
  message_type?: string | null
  turn_id?: string | null
  metadata?: Record<string, unknown>
  parts?: unknown
  timestamp_ms: number
}

/**
 * 从后端 API 消息中提取统一的 metadata
 */
function extractMetadataFromApi(message: BackendApiMessage): AgentMessageMetadata {
  const restMetadata = message.metadata || {}

  return {
    // 基础字段
    turnId: message.turnId
      ?? (typeof restMetadata.turnId === "string" ? restMetadata.turnId : undefined),

    // Agent 消息专用字段
    agentContent: message.agentContent ?? message.content,
    senderAgentId: message.senderAgentId ?? undefined,
    senderAgentName: message.senderAgentName ?? undefined,
    messageType: (message.messageType as "request" | "response" | "broadcast") ?? undefined,

    // A2A 通信字段
    fromAgentId: message.fromAgentId ?? undefined,
    fromAgentName: message.fromAgentName ?? undefined,

    // 保留其他后端元数据
    ...restMetadata,
  }
}

/**
 * 从 Runtime SSE 事件中提取统一的 metadata
 */
function extractMetadataFromSSE(event: RuntimeSSEEvent): AgentMessageMetadata {
  const eventMetadata = (event.metadata && typeof event.metadata === "object")
    ? event.metadata as Record<string, unknown>
    : {}

  // 提取 turnId：优先使用事件的 turn_id，其次使用 metadata.turnId
  const turnId = (typeof eventMetadata.turnId === "string" && eventMetadata.turnId)
    ? eventMetadata.turnId
    : (typeof event.turn_id === "string" && event.turn_id)
      ? event.turn_id
      : undefined

  return {
    // 基础字段
    turnId,

    // Agent 消息专用字段
    agentContent: event.role === "agent" ? event.content : undefined,
    senderAgentId: event.sender_agent_id ?? undefined,
    senderAgentName: event.sender_agent_name ?? undefined,
    messageType: (event.message_type as "request" | "response" | "broadcast") ?? undefined,

    // A2A 通信字段（SSE 事件可能没有，从 metadata 中提取）
    fromAgentId: (typeof eventMetadata.fromAgentId === "string" ? eventMetadata.fromAgentId : undefined),
    fromAgentName: (typeof eventMetadata.fromAgentName === "string" ? eventMetadata.fromAgentName : undefined),

    // 保留其他后端元数据
    ...eventMetadata,
  }
}

/**
 * 将后端 API 消息标准化为统一的 Message 对象
 */
export function normalizeApiMessage(message: BackendApiMessage): Message {
  const role = message.role as MessageRole
  const metadata = extractMetadataFromApi(message)

  // 解析 parts
  const parts: MessagePart[] = (message.parts?.length
    ? message.parts
    : [{ type: "text", text: message.content }]
  ) as MessagePart[]

  return {
    id: message.id,
    role,
    parts,
    metadata: metadata as unknown as Record<string, unknown>,
    createdAt: message.createdAt ? new Date(message.createdAt) : undefined,
  }
}

/**
 * 将 Runtime SSE 事件标准化为统一的 Message 对象
 */
export function normalizeRuntimeSSEEvent(event: RuntimeSSEEvent): Message {
  // 标准化 role：user/agent 保持不变，其他都映射为 assistant
  const role: MessageRole = (event.role === "user" || event.role === "agent")
    ? event.role
    : "assistant"

  const metadata = extractMetadataFromSSE(event)

  // 解析 parts
  const rawParts = Array.isArray(event.parts) ? event.parts : []
  const parts: MessagePart[] = rawParts.length > 0
    ? rawParts as MessagePart[]
    : [{ type: "text", text: event.content }]

  return {
    id: event.message_id,
    role,
    parts,
    metadata: metadata as unknown as Record<string, unknown>,
    createdAt: new Date(event.timestamp_ms),
  }
}

/**
 * 比较两个 metadata 对象是否一致（用于调试/测试）
 */
export function metadataEquals(
  a: AgentMessageMetadata,
  b: AgentMessageMetadata,
): boolean {
  const keysToCompare = [
    "turnId",
    "agentContent",
    "senderAgentId",
    "senderAgentName",
    "messageType",
    "fromAgentId",
    "fromAgentName",
  ]

  for (const key of keysToCompare) {
    const aVal = (a as Record<string, unknown>)[key]
    const bVal = (b as Record<string, unknown>)[key]
    if (aVal !== bVal) return false
  }

  return true
}
