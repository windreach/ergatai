import { useState } from "react";
import { Send } from "lucide-react";
import {
  useConversationStore,
  type ConversationMessagePart,
} from "../../../core/workspace/conversationStore";
import { useWorkspaceStore } from "../../../core/workspace/workspaceStore";

function getPartText(part: ConversationMessagePart) {
  if (part.type === "text") return part.content;
  if (part.type === "mention") return `@${part.displayName}`;
  if (part.type === "system_notice") return part.content;
  if (part.type === "task_ref") return `[任务] ${part.title}`;
  if (part.type === "artifact") return `[产出物] ${part.label}`;
  return "";
}

export function ChatPanel() {
  const [input, setInput] = useState("");
  const mode = useWorkspaceStore((state) => state.mode);
  const selectedConversationId = useWorkspaceStore((state) => state.selectedConversationId);
  const conversations = useConversationStore((state) => state.conversations);
  const allMessages = useConversationStore((state) => state.messages);
  const sendMessage = useConversationStore((state) => state.sendMessage);

  const conversation = conversations.find((item) => item.id === selectedConversationId)
    ?? conversations.find((item) => (mode === "group" ? item.kind === "group" : item.kind === "direct"));
  const messages = conversation
    ? allMessages.filter((message) => message.conversationId === conversation.id)
    : [];

  const handleSend = () => {
    if (!input.trim() || !conversation) return;

    sendMessage(conversation.id, input);
    setInput("");
  };

  const handleKeyPress = (event: React.KeyboardEvent) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-border-subtle px-4 py-3 text-sm font-medium text-text">
        {conversation ? `${conversation.title} · 主对话` : "选择对话"}
      </header>

      <div className="flex-1 overflow-y-auto p-4">
        {messages.map((message) => (
          <div
            key={message.id}
            className={`mb-4 flex ${message.senderKind === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[80%] rounded-lg px-4 py-2 ${
                message.senderKind === "user"
                  ? "bg-primary text-white"
                  : "bg-bg text-text"
              }`}
            >
              <div className="space-y-1 text-left">
                {message.parts.map((part, index) => (
                  <div key={`${message.id}-${index}`} className="text-sm">
                    {getPartText(part)}
                  </div>
                ))}
              </div>
              <div className="mt-1 text-xs opacity-70">
                {new Date(message.createdAt).toLocaleTimeString("zh-CN", {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="border-t border-border-subtle p-4">
        <div className="flex gap-2">
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyPress={handleKeyPress}
            placeholder={conversation ? "发送到当前主对话..." : "请先在左侧选择对话"}
            disabled={!conversation}
            className="flex-1 resize-none rounded-md border border-border-subtle bg-bg px-3 py-2 text-sm text-text placeholder:text-muted focus:border-primary focus:outline-none"
            rows={3}
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || !conversation}
            className="flex h-10 w-10 items-center justify-center rounded-md bg-primary text-white transition-colors hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
