/**
 * 统一状态管理 Hook
 * 抽象 AI SDK 和 conversationStore 两种数据源
 */

import { useMemo } from 'react';
import type { UnifiedMessage, UnifiedMessagePart } from '@ergatai/platform-core';
import type { ChatPanelProps } from '../ChatPanel.types';

/**
 * 统一的聊天状态接口
 */
export interface ChatState {
  messages: UnifiedMessage[];
  isLoading: boolean;
  error: Error | null;
}

/**
 * 统一的聊天操作接口
 */
export interface ChatActions {
  sendMessage: (content: string, parts?: UnifiedMessagePart[]) => Promise<void>;
  editMessage?: (messageId: string, content: string) => Promise<void>;
  deleteMessage?: (messageId: string) => Promise<void>;
  regenerateMessage?: (messageId: string) => Promise<void>;
  /** 停止生成 */
  stop?: () => void;
  /** 工具审批响应 */
  addToolApprovalResponse?: (toolCallId: string, approved: boolean) => void;
  /** 是否在发送中 */
  isSending?: boolean;
}

/**
 * 统一状态 Hook
 */
export function useChatState(props: Pick<ChatPanelProps, 'aiSdkTransport' | 'conversationStore'>): ChatState & ChatActions {
  const { aiSdkTransport, conversationStore } = props;

  // 策略 A: 使用 AI SDK
  if (aiSdkTransport) {
    return useAiSdkChatState(aiSdkTransport);
  }

  // 策略 B: 使用 conversationStore
  if (conversationStore) {
    return useConversationStoreChatState(conversationStore);
  }

  throw new Error('[useChatState] Either aiSdkTransport or conversationStore must be provided');
}

/**
 * AI SDK 数据源适配器
 */
function useAiSdkChatState(transport: ChatPanelProps['aiSdkTransport']): ChatState & ChatActions {
  if (!transport) {
    throw new Error('[useAiSdkChatState] transport is required');
  }

  const chat = transport.useChat();

  // 转换 AI SDK 消息为 UnifiedMessage
  const messages = useMemo(() => {
    return chat.messages.map(transformAiSdkMessage);
  }, [chat.messages]);

  const isSending = chat.status === 'submitted' || chat.status === 'streaming';

  return {
    messages,
    isLoading: isSending,
    error: chat.error ?? null,
    sendMessage: async (content, parts) => {
      await chat.sendMessage({ text: content }, { body: { parts } });
    },
    editMessage: async (messageId, content) => {
      // AI SDK 通过 sendMessage + messageId 实现编辑
      await chat.sendMessage({ text: content, messageId }, {});
    },
    deleteMessage: async (messageId) => {
      // AI SDK 不支持直接删除，需要通过 setMessages 实现
      const filtered = chat.messages.filter((m: any) => m.id !== messageId);
      chat.setMessages(filtered);
    },
    regenerateMessage: async (messageId) => {
      await chat.regenerate({ messageId });
    },
    stop: () => chat.stop(),
    addToolApprovalResponse: (toolCallId, approved) => {
      chat.addToolResult({
        tool: 'tool', // Placeholder - AI SDK requires this field
        toolCallId,
        output: JSON.stringify({ approved }),
      });
    },
    isSending,
  };
}

/**
 * conversationStore 数据源适配器
 */
function useConversationStoreChatState(store: NonNullable<ChatPanelProps['conversationStore']>): ChatState & ChatActions {
  const { conversation, messages: storeMessages, sendMessage, editMessage, deleteMessage } = store;

  // 转换 conversationStore 消息为 UnifiedMessage
  const messages = useMemo(() => {
    return storeMessages
      .filter(msg => msg.conversationId === conversation.id)
      .map(transformConversationStoreMessage);
  }, [storeMessages, conversation.id]);

  return {
    messages,
    isLoading: false, // conversationStore 目前没有 loading 状态
    error: null,
    sendMessage: async (content, _parts) => {
      // conversationStore 的 sendMessage 不接受 parts，只接受纯文本
      sendMessage(conversation.id, content);
    },
    editMessage: editMessage ? async (messageId, content) => {
      editMessage(messageId, content);
    } : undefined,
    deleteMessage: deleteMessage ? async (id) => {
      deleteMessage(id);
    } : undefined,
    regenerateMessage: async (_messageId) => {
      // conversationStore 不支持重新生成
      console.warn('[useConversationStoreChatState] Regenerate not supported');
    },
  };
}

/**
 * 转换 AI SDK 消息为 UnifiedMessage
 */
function transformAiSdkMessage(aiMsg: any): UnifiedMessage {
  return {
    id: aiMsg.id,
    role: aiMsg.role,
    parts: aiMsg.parts?.map(transformAiSdkPart) ?? [],
    createdAt: aiMsg.createdAt?.getTime?.() ?? Date.now(),
    conversationId: '', // AI SDK 不跟踪 conversationId
    status: aiMsg.status,
    aiSdkMetadata: {
      modelMessageId: aiMsg.id,
    },
  };
}

/**
 * 转换 AI SDK Part 为 UnifiedMessagePart
 */
function transformAiSdkPart(part: any): UnifiedMessagePart {
  switch (part.type) {
    case 'text':
      return { type: 'text', content: part.text ?? '' };
    case 'reasoning':
      return { type: 'reasoning', content: part.reasoning ?? part.text ?? '' };
    case 'tool-invocation':
      return {
        type: 'tool-invocation',
        toolInvocation: {
          toolCallId: part.toolInvocation?.toolCallId ?? '',
          toolName: part.toolInvocation?.toolName ?? 'unknown',
          args: part.toolInvocation?.args ?? {},
          state: part.toolInvocation?.state ?? 'partial-call',
          result: part.toolInvocation?.result,
        },
      };
    case 'file':
      return {
        type: 'file',
        file: {
          url: part.file?.url ?? part.url ?? '',
          name: part.file?.name ?? part.name ?? 'file',
          mimeType: part.file?.mediaType ?? part.mediaType ?? 'application/octet-stream',
        },
      };
    case 'source':
      // AI SDK source parts (citations)
      return {
        type: 'system_notice',
        content: `来源: ${part.source?.title ?? part.source?.url ?? 'unknown'}`,
        level: 'info',
      };
    case 'step-start':
      // Step start markers (for multi-step tool calls)
      return {
        type: 'system_notice',
        content: '开始新的处理步骤...',
        level: 'info',
      };
    default:
      console.warn('[transformAiSdkPart] Unknown part type:', part.type);
      return { type: 'text', content: `[Unknown part: ${part.type}]` };
  }
}

/**
 * 转换 conversationStore 消息为 UnifiedMessage
 */
function transformConversationStoreMessage(msg: any): UnifiedMessage {
  return {
    id: msg.id,
    role: msg.senderKind === 'user' ? 'user' : msg.senderKind === 'system' ? 'system' : 'assistant',
    parts: msg.parts?.map(transformConversationStorePart) ?? [],
    createdAt: new Date(msg.createdAt).getTime(),
    conversationId: msg.conversationId,
    collabMetadata: {
      mentions: msg.mentions,
      taskRefs: msg.taskRefs,
      approvalId: msg.approvalId,
    },
  };
}

/**
 * 转换 conversationStore Part 为 UnifiedMessagePart
 * conversationStore now uses UnifiedMessagePart natively, so this is mostly a pass-through
 * with fallback for any legacy fields.
 */
function transformConversationStorePart(part: UnifiedMessagePart): UnifiedMessagePart {
  // conversationStore now produces UnifiedMessagePart directly, so no transformation needed
  return part;
}
