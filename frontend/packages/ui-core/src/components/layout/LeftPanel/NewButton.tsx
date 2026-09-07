import { Plus } from "lucide-react";
import { useGroupStore } from "../../../core/workspace/groupStore";
import { useSessionStore } from "../../../core/workspace/sessionStore";
import { useWorkspaceStore, type WorkspaceMode } from "../../../core/workspace/workspaceStore";

interface NewButtonProps {
  mode: WorkspaceMode;
}

/**
 * Create a new conversation (group or session) and open it.
 * Shared between the expanded NewButton and the collapsed sidebar rail.
 */
export function createNewConversation(mode: WorkspaceMode): void {
  const timestamp = new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  const conversationId = mode === "group"
    ? useGroupStore.getState().addGroup({
        name: `新项目群 ${timestamp}`,
        members: ["你"],
        memberCount: 1,
        preview: "暂无消息",
        lastActive: "刚刚",
      })
    : useSessionStore.getState().addSession({
        agentName: `新 Agent ${timestamp}`,
        agentType: "Codex",
        preview: "暂无消息",
        lastActive: "刚刚",
      });

  useWorkspaceStore.getState().openConversation(mode, mode === "group" ? `group-${conversationId}` : `direct-${conversationId}`);
}

export function NewButton({ mode }: NewButtonProps) {
  const handleClick = () => createNewConversation(mode);

  return (
    <div className="border-b border-border-subtle p-3">
      <button
        onClick={handleClick}
        className="flex w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary/90"
      >
        <Plus className="h-4 w-4" />
        新建{mode === "group" ? "群聊" : "会话"}
      </button>
    </div>
  );
}
