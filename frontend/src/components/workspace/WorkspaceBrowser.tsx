import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Plus, X } from "lucide-react";

import { RuntimeWorkspace } from "@/components/workspace/RuntimeWorkspace";
import {
  removeWorkspaceDomainStores,
  useRuntimeWorkspaceStore,
} from "@/core/runtime/store";
import { cn } from "@/lib/utils";

export function WorkspaceBrowser() {
  const { t } = useTranslation();
  const workspaces = useRuntimeWorkspaceStore((state) => state.workspaces);
  const activeWorkspaceId = useRuntimeWorkspaceStore((state) => state.activeWorkspaceId);
  const createWorkspace = useRuntimeWorkspaceStore((state) => state.createWorkspace);
  const closeWorkspace = useRuntimeWorkspaceStore((state) => state.closeWorkspace);
  const activateWorkspace = useRuntimeWorkspaceStore((state) => state.activateWorkspace);
  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId);

  useEffect(() => {
    if (workspaces.length > 0) return;
    createWorkspace();
  }, [createWorkspace, workspaces.length]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg text-text">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border-subtle bg-surface px-2">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {workspaces.map((workspace, index) => {
            const active = workspace.id === activeWorkspaceId;

            return (
              <button
                key={workspace.id}
                type="button"
                onClick={() => activateWorkspace(workspace.id)}
                className={cn(
                  "group flex h-7 min-w-[132px] max-w-[220px] shrink-0 items-center gap-2 rounded-lg border px-2 text-left text-[12px] transition-colors",
                  active
                    ? "border-border-subtle bg-bg text-text"
                    : "border-transparent text-muted hover:bg-hover hover:text-text",
                )}
              >
                <span className="min-w-0 flex-1 truncate">
                  {workspace.title || t("workspace.defaultTitle", { index: index + 1 })}
                </span>
                <span
                  role="button"
                  tabIndex={-1}
                  aria-label={t("workspace.closeWorkspace")}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (closeWorkspace(workspace.id)) {
                      removeWorkspaceDomainStores(workspace.id);
                    }
                  }}
                  className={cn(
                    "flex h-4 w-4 shrink-0 items-center justify-center rounded-sm text-muted transition-colors hover:bg-hover hover:text-text",
                    active ? "opacity-70" : "opacity-0 group-hover:opacity-70",
                  )}
                >
                  <X className="h-3 w-3" />
                </span>
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => createWorkspace()}
            aria-label={t("workspace.newWorkspace")}
            title={t("workspace.newWorkspace")}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-hover hover:text-text"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      {activeWorkspace ? (
        <RuntimeWorkspace key={activeWorkspace.id} workspaceId={activeWorkspace.id} />
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-faint">
          {t("workspace.emptyWorkspace")}
        </div>
      )}
    </div>
  );
}
