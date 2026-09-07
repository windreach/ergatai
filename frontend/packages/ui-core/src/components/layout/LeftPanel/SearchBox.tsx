import { useEffect } from "react";
import { Search, X } from "lucide-react";
import { useWorkspaceStore } from "../../../core/workspace/workspaceStore";

export function SearchBox() {
  const searchQuery = useWorkspaceStore((state) => state.searchQuery);
  const setSearchQuery = useWorkspaceStore((state) => state.setSearchQuery);

  useEffect(() => {
    const query = new URLSearchParams(window.location.search).get("q");
    if (query) setSearchQuery(query);
  }, [setSearchQuery]);

  return (
    <div className="border-b border-border-subtle p-3">
      <div className="flex items-center gap-2 rounded-md bg-bg px-3 py-2">
        <Search className="h-4 w-4 text-muted" />
        <input
          type="text"
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          placeholder="搜索任务、群聊、会话"
          className="min-w-0 flex-1 bg-transparent text-sm text-text placeholder:text-muted outline-none"
        />
        {searchQuery && (
          <button
            type="button"
            onClick={() => setSearchQuery("")}
            aria-label="清空搜索"
            className="rounded p-1 text-muted transition-colors hover:bg-surface hover:text-text"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}
