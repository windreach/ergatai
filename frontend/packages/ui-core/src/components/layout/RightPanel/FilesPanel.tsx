import { FileCode, FileText, Folder } from "lucide-react";
import { usePanelAutomation } from "../../../core/workspace/panelAutomation";

interface FileChange {
  id: string;
  path: string;
  type: "added" | "modified" | "deleted";
  status: "staged" | "unstaged";
}

export function FilesPanel() {
  const requestedPath = usePanelAutomation((state) => state.panelContext.files?.filePath);
  // Mock data
  const changes: FileChange[] = [
    { id: "1", path: "src/App.tsx", type: "modified", status: "staged" },
    { id: "2", path: "src/components/Layout.tsx", type: "added", status: "staged" },
    { id: "3", path: "src/utils/store.ts", type: "modified", status: "unstaged" },
    { id: "4", path: "README.md", type: "modified", status: "unstaged" },
  ];

  const getFileIcon = (path: string) => {
    if (path.endsWith(".tsx") || path.endsWith(".ts")) {
      return <FileCode className="h-4 w-4 text-blue-500" />;
    }
    if (path.endsWith(".md") || path.endsWith(".txt")) {
      return <FileText className="h-4 w-4 text-gray-500" />;
    }
    return <FileText className="h-4 w-4 text-gray-500" />;
  };

  const getTypeColor = (type: FileChange["type"]) => {
    switch (type) {
      case "added":
        return "text-green-500";
      case "modified":
        return "text-yellow-500";
      case "deleted":
        return "text-red-500";
    }
  };

  const getTypeLabel = (type: FileChange["type"]) => {
    switch (type) {
      case "added":
        return "新增";
      case "modified":
        return "修改";
      case "deleted":
        return "删除";
    }
  };

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border-subtle px-4 py-2">
        <div className="flex items-center gap-2">
          <Folder className="h-4 w-4 text-muted" />
          <span className="text-sm font-medium text-text">文件变更</span>
        </div>
        <span className="text-xs text-muted">{changes.length} 个文件</span>
      </div>

      {/* File List */}
      <div className="flex-1 overflow-y-auto">
        <div className="p-2">
          {requestedPath && (
            <div className="mb-3 rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-xs text-text">
              当前上下文：{requestedPath}
            </div>
          )}

          {/* Staged Changes */}
          <div className="mb-4">
            <div className="mb-2 flex items-center gap-2 px-2">
              <span className="text-xs font-medium text-text">已暂存</span>
              <span className="text-xs text-muted">
                {changes.filter((f) => f.status === "staged").length}
              </span>
            </div>
            {changes
              .filter((f) => f.status === "staged")
              .map((file) => (
                <div
                  key={file.id}
                  className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-bg"
                >
                  {getFileIcon(file.path)}
                  <div className="flex-1 min-w-0">
                    <div className="truncate text-sm text-text">{file.path}</div>
                  </div>
                  <span className={`text-xs ${getTypeColor(file.type)}`}>
                    {getTypeLabel(file.type)}
                  </span>
                </div>
              ))}
          </div>

          {/* Unstaged Changes */}
          <div>
            <div className="mb-2 flex items-center gap-2 px-2">
              <span className="text-xs font-medium text-text">未暂存</span>
              <span className="text-xs text-muted">
                {changes.filter((f) => f.status === "unstaged").length}
              </span>
            </div>
            {changes
              .filter((f) => f.status === "unstaged")
              .map((file) => (
                <div
                  key={file.id}
                  className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-bg"
                >
                  {getFileIcon(file.path)}
                  <div className="flex-1 min-w-0">
                    <div className="truncate text-sm text-text">{file.path}</div>
                  </div>
                  <span className={`text-xs ${getTypeColor(file.type)}`}>
                    {getTypeLabel(file.type)}
                  </span>
                </div>
              ))}
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="border-t border-border-subtle p-3">
        <div className="flex gap-2">
          <button className="flex-1 rounded bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary/90">
            全部暂存
          </button>
          <button className="flex-1 rounded border border-border-subtle px-3 py-1.5 text-xs font-medium text-text hover:bg-bg">
            提交
          </button>
        </div>
      </div>
    </div>
  );
}
