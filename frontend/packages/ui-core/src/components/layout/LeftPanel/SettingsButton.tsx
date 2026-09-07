import { Settings } from "lucide-react";

export function SettingsButton() {
  const handleClick = () => {
    // TODO: 打开设置面板
    console.log("打开设置");
  };

  return (
    <button
      onClick={handleClick}
      className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-bg"
    >
      <Settings className="h-4 w-4 text-muted" />
      <span className="text-sm text-text">设置</span>
    </button>
  );
}
