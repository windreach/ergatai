/**
 * 统一的消息 Part 类型系统
 * 合并 AI SDK parts + conversationStore parts，支持所有对话场景
 */

// === 基础文本类 ===

export interface TextPart {
  type: 'text';
  content: string;
  metadata?: {
    edited?: boolean;
    timestamp?: number;
  };
}

export interface ReasoningPart {
  type: 'reasoning';
  content: string;
  status?: 'thinking' | 'completed';
}

// === AI SDK 工具类 ===

export interface ToolInvocationPart {
  type: 'tool-invocation';
  toolInvocation: {
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
    state: 'partial-call' | 'call' | 'result';
    result?: unknown;
  };
}

export interface ToolResultPart {
  type: 'tool-result';
  toolCallId: string;
  result: unknown;
  isError?: boolean;
}

// === 协作类 (conversationStore) ===

export interface MentionPart {
  type: 'mention';
  mention: {
    agentId: string;
    agentName: string;
    avatar?: string;
  };
}

export interface TaskRefPart {
  type: 'task_ref';
  taskRef: {
    taskId: string;
    title: string;
    status: 'pending' | 'running' | 'completed' | 'failed';
    assignee?: string;
  };
}

export interface ActivityCardPart {
  type: 'activity_card';
  activityCard: {
    cardId: string;
    title: string;
    description?: string;
    status: 'info' | 'success' | 'warning' | 'error';
    metadata?: Record<string, unknown>;
    actions?: ActivityCardAction[];
  };
}

export interface ActivityCardAction {
  actionId: string;
  label: string;
  variant: 'primary' | 'secondary' | 'danger';
  onClick: string; // 事件名称
}

export interface ApprovalPart {
  type: 'approval';
  approval: {
    approvalId: string;
    title: string;
    description?: string;
    status: 'pending' | 'approved' | 'rejected';
    requestedBy: string;
    requestedAt: number;
    respondedAt?: number;
    respondedBy?: string;
    metadata?: Record<string, unknown>;
  };
}

// === 媒体类 ===

export interface FilePart {
  type: 'file';
  file: {
    url: string;
    name: string;
    mimeType: string;
    size?: number;
    thumbnail?: string;
  };
}

export interface ArtifactPart {
  type: 'artifact';
  artifact: {
    artifactId: string;
    type: 'code' | 'document' | 'image' | 'data';
    title: string;
    content: string;
    language?: string;
    metadata?: Record<string, unknown>;
  };
}

// === 系统类 ===

export interface SystemNoticePart {
  type: 'system_notice';
  content: string;
  level: 'info' | 'warning' | 'error';
}

// === 联合类型 ===

/**
 * 统一的消息 Part 类型
 * 包含所有可能的消息内容类型
 */
export type UnifiedMessagePart =
  // 基础文本类
  | TextPart
  | ReasoningPart
  // AI SDK 工具类
  | ToolInvocationPart
  | ToolResultPart
  // 协作类
  | MentionPart
  | TaskRefPart
  | ActivityCardPart
  | ApprovalPart
  // 媒体类
  | FilePart
  | ArtifactPart
  // 系统类
  | SystemNoticePart;

// === Type Guards ===

export function isTextPart(part: UnifiedMessagePart): part is TextPart {
  return part.type === 'text';
}

export function isReasoningPart(part: UnifiedMessagePart): part is ReasoningPart {
  return part.type === 'reasoning';
}

export function isToolInvocationPart(part: UnifiedMessagePart): part is ToolInvocationPart {
  return part.type === 'tool-invocation';
}

export function isToolResultPart(part: UnifiedMessagePart): part is ToolResultPart {
  return part.type === 'tool-result';
}

export function isMentionPart(part: UnifiedMessagePart): part is MentionPart {
  return part.type === 'mention';
}

export function isTaskRefPart(part: UnifiedMessagePart): part is TaskRefPart {
  return part.type === 'task_ref';
}

export function isActivityCardPart(part: UnifiedMessagePart): part is ActivityCardPart {
  return part.type === 'activity_card';
}

export function isApprovalPart(part: UnifiedMessagePart): part is ApprovalPart {
  return part.type === 'approval';
}

export function isFilePart(part: UnifiedMessagePart): part is FilePart {
  return part.type === 'file';
}

export function isArtifactPart(part: UnifiedMessagePart): part is ArtifactPart {
  return part.type === 'artifact';
}

export function isSystemNoticePart(part: UnifiedMessagePart): part is SystemNoticePart {
  return part.type === 'system_notice';
}
