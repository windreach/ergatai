/**
 * 统一的消息接口
 * 支持 AI SDK 和 conversationStore 两种数据源
 */

import type { UnifiedMessagePart } from './unified-message-parts';

export interface UnifiedMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  parts: UnifiedMessagePart[];

  // 元数据
  createdAt: number;
  updatedAt?: number;

  // 会话关联
  conversationId: string;

  // 分支系统
  branchId?: string;
  parentMessageId?: string;

  // 附件
  attachments?: Attachment[];

  // 交互状态
  status?: 'streaming' | 'complete' | 'error';

  // AI SDK 特有字段 (可选)
  aiSdkMetadata?: {
    modelMessageId?: string;
    transportMessageId?: string;
  };

  // conversationStore 特有字段 (可选)
  collabMetadata?: {
    mentions?: string[]; // agent IDs
    taskRefs?: string[]; // task IDs
    approvalId?: string;
  };
}

export interface Attachment {
  id: string;
  type: 'file' | 'image';
  name: string;
  url: string;
  mimeType: string;
  size: number;
}

/**
 * 消息状态
 */
export type MessageStatus = 'sending' | 'sent' | 'streaming' | 'complete' | 'error';

/**
 * 消息发送选项
 */
export interface SendMessageOptions {
  conversationId: string;
  content: string;
  parts?: UnifiedMessagePart[];
  attachments?: Attachment[];
  metadata?: Record<string, unknown>;
}

/**
 * 消息编辑选项
 */
export interface EditMessageOptions {
  messageId: string;
  content: string;
  parts?: UnifiedMessagePart[];
}
