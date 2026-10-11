import { useEffect, useRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createSplitview, Orientation, SplitviewPanel, type PanelViewInitParameters } from "dockview";
import "dockview/dist/styles/dockview.css";

import { AgentSidebar } from "@/components/workspace/AgentSidebar";
import { ToolWorkspace } from "@/components/workspace/ToolWorkspace";
import { ChatPanel } from "@/components/tabs/ChatPanel";
import { useSessionStore } from "@/core/session/store";

class ReactSplitPanel extends SplitviewPanel {
  private root: Root | null = null;
  private readonly renderContent: () => ReactNode;

  constructor(
    id: string,
    component: string,
    renderContent: () => ReactNode,
  ) {
    super(id, component);
    this.renderContent = renderContent;
    this.addDisposables({
      dispose: () => {
        const currentRoot = this.root;
        this.root = null;
        if (currentRoot) {
          queueMicrotask(() => currentRoot.unmount());
        }
      },
    });
  }

  init(parameters: PanelViewInitParameters) {
    super.init(parameters);
    this.root = createRoot(this.element);
    this.root.render(this.renderContent());
  }

  protected getComponent() {
    return {
      update: () => {},
      dispose: () => {},
    };
  }
}

function ConversationPanel() {
  const activeSessionId = useSessionStore((state) => state.activeSessionId);

  return <ChatPanel conversationId={activeSessionId ?? undefined} />;
}

const panelComponents: Record<string, () => ReactNode> = {
  sidebar: () => <AgentSidebar />,
  conversation: () => <ConversationPanel />,
  tools: () => <ToolWorkspace />,
};

export function WorkspaceShell() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const splitview = createSplitview(container, {
      orientation: Orientation.HORIZONTAL,
      proportionalLayout: false,
      className: "ergatai-splitview",
      createComponent: ({ id, name }) => new ReactSplitPanel(
        id,
        name,
        panelComponents[name] ?? (() => null),
      ),
    });

    splitview.addPanel({
      id: "agent-sidebar",
      component: "sidebar",
      minimumSize: 220,
      maximumSize: 320,
    });
    splitview.addPanel({
      id: "conversation-workspace",
      component: "conversation",
      minimumSize: 420,
    });
    splitview.addPanel({
      id: "tool-workspace",
      component: "tools",
      minimumSize: 420,
    });

    return () => {
      splitview.dispose();
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className="h-full min-h-0 w-full bg-bg text-text"
    />
  );
}
