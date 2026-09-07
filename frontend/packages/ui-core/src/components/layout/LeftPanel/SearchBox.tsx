import { Search } from "lucide-react";

export function SearchBox() {
  return (
    <div className="border-b border-border-subtle p-3">
      <div className="flex items-center gap-2 rounded-md bg-bg px-3 py-2">
        <Search className="h-4 w-4 text-muted" />
        <input
          type="text"
          placeholder="搜索..."
          className="flex-1 bg-transparent text-sm text-text placeholder:text-muted outline-none"
        />
      </div>
    </div>
  );
}
