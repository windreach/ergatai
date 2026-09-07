import { Plus } from "lucide-react";

interface NewButtonProps {
  mode: "group" | "agent";
}

export function NewButton({ mode }: NewButtonProps) {
  const handleClick = () => {
    // TODO: 实现新建逻辑
    console.log(`新建${mode === "group" ? "群聊" : "会话"}`);
  };

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
