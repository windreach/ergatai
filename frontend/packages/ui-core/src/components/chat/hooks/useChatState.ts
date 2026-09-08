import { useMemo } from 'react';
import type { UnifiedMessage, UnifiedMessagePart } from '@ergatai/platform-core';
import type { ConversationStoreDataSource } from '../ChatPanel.types';

export interface ChatState {
  messages: UnifiedMessage[];
  isLoading: boolean;
  error: Error | null;
}

export interface ChatActions {
  sendMessage: (content: string, parts?: UnifiedMessagePart[]) => Promise<void>;
  editMessage?: (messageId: string, content: string) => Promise<void>;
  deleteMessage?: (messageId: string) => Promise<void>;
  regenerateMessage?: (messageId: string) => Promise<void>;
}

export function useConversationStoreChatState(store: ConversationStoreDataSource): ChatState & ChatActions {
  const { conversation, messages: storeMessages, sendMessage, editMessage, deleteMessage } = store;

  const messages = useMemo(() => (
    storeMessages
      .filter(message => message.conversationId === conversation.id)
      .map(transformMessage)
  ), [storeMessages, conversation.id]);

  return {
    messages,
    isLoading: false,
    error: null,
    sendMessage: async (content) => {
      sendMessage(conversation.id, content);
    },
    editMessage: editMessage
      ? async (messageId, content) => {
          editMessage(messageId, content);
        }
      : undefined,
    deleteMessage: deleteMessage
      ? async (messageId) => {
          deleteMessage(messageId);
        }
      : undefined,
    regenerateMessage: async () => {
      console.warn('[useConversationStoreChatState] Regenerate not supported');
    },
  };
}

function transformMessage(message: ConversationStoreDataSource['messages'][number]): UnifiedMessage {
  return {
    id: message.id,
    role: message.senderKind === 'user' ? 'user' : message.senderKind === 'system' ? 'system' : 'assistant',
    parts: message.parts ?? [],
    createdAt: new Date(message.createdAt).getTime(),
    conversationId: message.conversationId,
  };
}
