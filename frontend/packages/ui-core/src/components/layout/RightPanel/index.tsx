import { MessageCircle, Terminal, FolderOpen, CheckSquare, PanelRight } from "lucide-react";
import { ChatPanel } from "./ChatPanel";
import { TerminalPanel } from "./TerminalPanel";
import { FilesPanel } from "./FilesPanel";
import { ReviewPanel } from "./ReviewPanel";
import { usePanelAutomation } from "../../../core/workspace/panelAutomation";

interface RightPanelProps {
  isOpen?: boolean;
  onToggle?: () => void;
}

const panelComponents = {
  chat: () => <ChatPanel />,
  terminal: () => <TerminalPanel />,
  files: () => <FilesPanel />,
  review: () => <ReviewPanel />,
  placeholder: () => <PlaceholderPanel />,
};

export function RightPanel({ isOpen = true, onToggle }: RightPanelProps) {
  const activePanel = usePanelAutomation((state) => state.activePanel);
  const openPanels = usePanelAutomation((state) => state.openPanels);
  const setActivePanel = usePanelAutomation((state) => state.setActivePanel);
  const openPanel = usePanelAutomation((state) => state.openPanel);
  const closePanel = usePanelAutomation((state) => state.closePanel);

  const handleTabClick = (panel: typeof activePanel) => {
    openPanel(panel);
  };

  const handleTabClose = (panel: typeof activePanel) => {
    closePanel(panel);
  };

  const handleNewTab = () => {
    // TODO: 打开新建面板选择器
    console.log("新建标签页");
  };

  if (!isOpen) {
    return (
      <div className="flex h-full w-12 items-start border-l border-border-subtle bg-surface pt-2">
        <button
          onClick={onToggle}
          className="p-2 text-muted hover:text-text"
          title="展开工具面板"
        >
          <PanelRight className="h-5 w-5" />
        </button>
      </div>
    );
  }

  const ActiveComponent = panelComponents[activePanel];

  return (
    <div className="flex h-full w-[400px] flex-col border-l border-border-subtle bg-surface">
      {/* Tab Bar */}
      <div className="flex items-center border-b border-border-subtle bg-bg">
        <div className="flex flex-1 overflow-x-auto">
          {openPanels.map((panel) => (
            <TabButton
              key={panel}
              panel={panel}
              isActive={panel === activePanel}
              onClick={() => setActivePanel(panel)}
              onClose={() => handleTabClose(panel)}
            />
          ))}
        </div>
        <button
          onClick={handleNewTab}
          className="flex h-8 w-8 flex-shrink-0 items-center justify-center text-muted hover:text-text"
          title="新建标签页"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
        </button>
      </div>

      {/* Panel Content */}
      <div className="flex-1 overflow-hidden">
        <ActiveComponent />
      </div>
    </div>
  );
}

function TabButton({
  panel,
  isActive,
  onClick,
  onClose,
}: {
  panel: "chat" | "terminal" | "files" | "review" | "placeholder";
  isActive: boolean;
  onClick: () => void;
  onClose: () => void;
}) {
  const panelConfig = {
    chat: { icon: MessageCircle, label: "对话" },
    terminal: { icon: Terminal, label: "终端" },
    files: { icon: FolderOpen, label: "文件" },
    review: { icon: CheckSquare, label: "审查" },
    placeholder: { icon: PanelRight, label: "占位" },
  };

  const config = panelConfig[panel];
  const Icon = config.icon;

  return (
    <div
      className={`flex items-center gap-1 border-r border-border-subtle px-3 py-2 text-sm ${
        isActive ? "bg-surface text-text" : "text-muted hover:bg-surface/50 hover:text-text"
      }`}
    >
      <button onClick={onClick} className="flex items-center gap-1">
        <Icon className="h-4 w-4" />
        <span>{config.label}</span>
      </button>
      <button
        onClick={onClose}
        className="ml-1 text-muted hover:text-text"
        title="关闭"
      >
        <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}

// Placeholder implementation for the placeholder panel
function PlaceholderPanel() {
  return (
    <div className="flex h-full flex-col items-center justify-center p-4 text-center">
      <PanelRight className="mb-2 h-12 w-12 text-muted" />
      <h3 className="text-sm font-medium text-text">占位面板</h3>
      <p className="text-xs text-muted">备用面板，可用于扩展功能</p>
    </div>
  );
}
