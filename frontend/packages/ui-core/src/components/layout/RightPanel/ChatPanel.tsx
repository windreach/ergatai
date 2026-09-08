import { useMemo } from "react";
import { useWorkspaceStore } from "../../../core/workspace/workspaceStore";
import { useConversationStore } from "../../../core/workspace/conversationStore";
import { ChatPanel as UnifiedChatPanel } from "../../chat/ChatPanel";

/**
 * RightPanel ChatPanel - 使用统一 ChatPanel 组件
 * mode='sidebar' 简化功能，适合侧边栏场景
 */
export function ChatPanel() {
  const mode = useWorkspaceStore((state) => state.mode);
  const selectedConversationId = useWorkspaceStore((state) => state.selectedConversationId);
  const conversations = useConversationStore((state) => state.conversations);
  const allMessages = useConversationStore((state) => state.messages);
  const sendMessage = useConversationStore((state) => state.sendMessage);

  const conversation = conversations.find((item) => item.id === selectedConversationId)
    ?? conversations.find((item) => (mode === "group" ? item.kind === "group" : item.kind === "direct"));

  const messages = useMemo(() => {
    if (!conversation) return [];
    return allMessages.filter((message) => message.conversationId === conversation.id);
  }, [conversation, allMessages]);

  if (!conversation) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <div className="mb-2 text-4xl">💬</div>
          <p className="text-sm text-muted">请先在左侧选择对话</p>
        </div>
      </div>
    );
  }

  return (
    <UnifiedChatPanel
      mode="sidebar"
      conversationId={conversation.id}
      conversationStore={{
        conversation,
        messages,
        sendMessage,
      }}
      className="h-full"
    />
  );
}
