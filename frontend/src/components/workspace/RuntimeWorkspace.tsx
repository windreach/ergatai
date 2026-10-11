import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { useTranslation } from "react-i18next";

import { ConversationArea, WorkspaceArea } from "@/components/layout/WorkspaceTabs";
import { getWorkspaceDomainStores } from "@/core/runtime/store";

const defaultConversationRatio = 0.38;
const minimumConversationRatio = 0.2;
const maximumConversationRatio = 0.8;

export function RuntimeWorkspace({ workspaceId }: { workspaceId: string }) {
  const { t } = useTranslation();
  const { conversation, workspace } = getWorkspaceDomainStores(workspaceId);
  const conversationTabCount = conversation((state) => state.tabs.length);
  const initializedRef = useRef(false);
  const [conversationRatio, setConversationRatio] = useState(defaultConversationRatio);
  const [resizing, setResizing] = useState(false);

  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;

    const conversationStore = conversation.getState();
    const workspaceStore = workspace.getState();
    if (conversationStore.tabs.length === 0) {
      conversationStore.open("chat", { agentId: `chat-${crypto.randomUUID()}` });
    }
    if (workspaceStore.tabs.length === 0) {
      workspaceStore.open("terminal");
    }
  }, [conversation, workspace]);

  useEffect(() => {
    if (conversationTabCount === 0) {
      initializedRef.current = false;
    }
  }, [conversationTabCount]);

  function handleResizePointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setResizing(true);
  }

  function handleResizePointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!resizing || event.buttons !== 1) return;
    const container = event.currentTarget.parentElement;
    if (!container) return;
    const ratio = event.clientX / container.getBoundingClientRect().width;
    setConversationRatio(Math.min(maximumConversationRatio, Math.max(minimumConversationRatio, ratio)));
  }

  function handleResizePointerUp(event: PointerEvent<HTMLDivElement>) {
    if (!resizing) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    setResizing(false);
  }

  function handleResizeKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 0.1 : 0.03;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setConversationRatio((ratio) => Math.max(minimumConversationRatio, ratio - step));
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      setConversationRatio((ratio) => Math.min(maximumConversationRatio, ratio + step));
    }
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden bg-bg">
      <div className="flex min-h-0 min-w-0 overflow-hidden" style={{ width: `${conversationRatio * 100}%` }}>
        <ConversationArea useStore={conversation} />
      </div>
      <div
        role="separator"
        aria-label={t("workspace.domainResizeHandle")}
        aria-orientation="vertical"
        aria-valuemin={20}
        aria-valuemax={80}
        aria-valuenow={Math.round(conversationRatio * 100)}
        tabIndex={0}
        onDoubleClick={() => setConversationRatio(defaultConversationRatio)}
        onKeyDown={handleResizeKeyDown}
        onPointerDown={handleResizePointerDown}
        onPointerMove={handleResizePointerMove}
        onPointerUp={handleResizePointerUp}
        onPointerCancel={handleResizePointerUp}
        className={`relative w-px shrink-0 cursor-col-resize bg-border-subtle transition-colors hover:bg-accent/60 ${
          resizing ? "bg-accent" : ""
        }`}
      >
        <span className="absolute inset-y-0 left-1/2 w-3 -translate-x-1/2" />
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <WorkspaceArea useStore={workspace} />
      </div>
    </div>
  );
}
