interface ModeTabsProps {
  mode: "group" | "agent";
  onChange: (mode: "group" | "agent") => void;
}

export function ModeTabs({ mode, onChange }: ModeTabsProps) {
  return (
    <div className="flex items-stretch border-b border-border-subtle">
      <button
        onClick={() => onChange("group")}
        className={`flex-1 px-4 py-2 text-sm font-medium transition-colors ${
          mode === "group"
            ? "border-b-2 border-primary text-primary"
            : "text-muted hover:text-text"
        }`}
      >
        群聊模式
      </button>
      <button
        onClick={() => onChange("agent")}
        className={`flex-1 px-4 py-2 text-sm font-medium transition-colors ${
          mode === "agent"
            ? "border-b-2 border-primary text-primary"
            : "text-muted hover:text-text"
        }`}
      >
        Agent 模式
      </button>
    </div>
  );
}
