/**
 * 统一 ChatPanel 的类型定义
 * 合并了 tabs/ChatPanel 和 chat/ChatPanel 的 props
 */

import type { ReactNode } from 'react';
import type { UseChatHelpers } from '@ai-sdk/react';
import type { UnifiedMessagePart } from '@ergatai/platform-core';

/**
 * 对话模式
 */
export type ChatMode = 'single' | 'group' | 'sidebar';

export type ConversationKind = 'group' | 'direct';
export type MessageSenderKind = 'user' | 'agent' | 'system';

export interface ConversationMember {
  id: string;
  name: string;
  kind: 'user' | 'agent';
  agentType?: string;
}

export interface Conversation {
  id: string;
  kind: ConversationKind;
  title: string;
  members: ConversationMember[];
}

export interface ConversationMessage {
  id: string;
  conversationId: string;
  senderKind: MessageSenderKind;
  senderId: string;
  senderName: string;
  parts: UnifiedMessagePart[];
  createdAt: string;
}

/**
 * ChatPanel 功能配置
 */
export interface ChatPanelFeatures {
  /** 消息分支系统 */
  branching?: boolean;
  /** 消息编辑功能 */
  messageEditing?: boolean;
  /** 重新生成功能 */
  regeneration?: boolean;
  /** 附件上传 */
  attachments?: boolean;
  /** @提及功能 */
  mentions?: boolean;
  /** 任务引用 */
  taskReferences?: boolean;
  /** 审批流 */
  approvals?: boolean;
  /** 活动卡片 */
  activityCards?: boolean;
  /** 点赞/复制 */
  reactions?: boolean;
  /** 灯箱预览 */
  lightbox?: boolean;
  /** 滚动导航 */
  scrollNavigation?: boolean;
}

/**
 * AI SDK 数据源配置
 */
export interface AiSdkDataSource {
  useChat: () => UseChatHelpers<any>;
}

/**
 * conversationStore 数据源配置
 */
export interface ConversationStoreDataSource {
  conversation: Conversation;
  messages: ConversationMessage[];
  sendMessage: (conversationId: string, content: string) => void;
  editMessage?: (messageId: string, content: string) => void;
  deleteMessage?: (messageId: string) => void;
}

/**
 * ChatPanel Props — 统一了 tabs/ChatPanel 和 chat/ChatPanel 的 props
 *
 * 数据源优先级:
 * 1. conversationStore (如果提供)
 * 2. aiSdkTransport (如果提供)
 * 3. 默认: 使用 chatTransport + conversationId 进行 IndexedDB 持久化
 */
export interface ChatPanelProps {
  /** 对话模式 */
  mode?: ChatMode;
  /** 功能配置 */
  features?: ChatPanelFeatures;
  /** 会话 ID (用于 AI SDK 持久化) */
  conversationId?: string;
  /** Agent 名称 (显示在空状态) */
  agentName?: string;
  /** Agent ID (单聊模式, 同 agentName 的别名) */
  agentId?: string;
  /** 参与者 IDs (群聊模式) */
  participantIds?: string[];

  /** 数据源：AI SDK (高级用法，提供自定义 useChat) */
  aiSdkTransport?: AiSdkDataSource;
  /** 数据源：conversationStore */
  conversationStore?: ConversationStoreDataSource;
  /** Optional header action rendered at the top-left of the chat panel. */
  headerLeading?: ReactNode;
  /** Called after local chat messages are persisted. */
  onConversationSaved?: (conversationId: string) => void;

  /** @提及选择回调 */
  onMentionSelect?: (agentId: string) => void;
  /** 任务点击回调 */
  onTaskClick?: (taskId: string) => void;
  /** 审批操作回调 */
  onApprovalAction?: (approvalId: string, action: 'approve' | 'reject') => void;

  /** 自定义类名 */
  className?: string;
  /** 最大高度 */
  maxHeight?: string | number;
}

/**
 * 默认功能配置（单聊模式）
 */
export const DEFAULT_FEATURES: ChatPanelFeatures = {
  branching: true,
  messageEditing: true,
  regeneration: true,
  attachments: true,
  mentions: false,
  taskReferences: false,
  approvals: false,
  activityCards: false,
  reactions: true,
  lightbox: true,
  scrollNavigation: true,
};

/**
 * 群聊功能配置
 */
export const GROUP_CHAT_FEATURES: ChatPanelFeatures = {
  ...DEFAULT_FEATURES,
  mentions: true,
  taskReferences: true,
  activityCards: true,
  approvals: true,
};

/**
 * 侧边栏功能配置（简化版）
 */
export const SIDEBAR_FEATURES: ChatPanelFeatures = {
  ...DEFAULT_FEATURES,
  branching: false,
  attachments: false,
  scrollNavigation: false,
  reactions: false,
};

/**
 * 根据模式获取默认功能配置
 */
export function getFeaturesForMode(mode: ChatMode): ChatPanelFeatures {
  switch (mode) {
    case 'group':
      return GROUP_CHAT_FEATURES;
    case 'sidebar':
      return SIDEBAR_FEATURES;
    case 'single':
    default:
      return DEFAULT_FEATURES;
  }
}
