import i18n from "@/lib/i18n"
import { memo, useMemo, useState, useCallback } from "react"
import { ChevronDown, MoreVertical, RotateCcw, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { trpc } from "../../lib/trpc"
import { cn } from "../../lib/utils"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu"
import { WorkspaceDeleteDialog } from "./workspace-delete-dialog"
import type { ErgataiWorkspace } from "../../../main/lib/trpc/routers/ergatai"

type ArchivedWorkspaceListProps = {
  searchQuery?: string
  collaborationMode: "supervisor" | "group"
  onWorkspaceSelect?: (workspaceId: string) => void
  onWorkspaceRestored?: (workspaceId: string) => void
  onWorkspaceDeleted?: (workspaceId: string) => void
  selectedWorkspaceId?: string | null
}

const ArchivedWorkspaceItem = memo(({
  workspace,
  selectedWorkspaceId,
  onWorkspaceSelect,
  onWorkspaceRestored,
  onWorkspaceDeleted,
}: {
  workspace: ErgataiWorkspace
  selectedWorkspaceId?: string | null
  onWorkspaceSelect?: (workspaceId: string) => void
  onWorkspaceRestored?: (workspaceId: string) => void
  onWorkspaceDeleted?: (workspaceId: string) => void
}) => {
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const utils = trpc.useUtils()

  const handleDeleteOpen = useCallback((event: { preventDefault: () => void }) => {
    event.preventDefault()
    setDeleteDialogOpen(true)
  }, [])
  const isSelected = selectedWorkspaceId === workspace.id

  const { data: status } = trpc.ergatai.workspaceStatus.useQuery(
    { id: workspace.id },
    { staleTime: 10_000 },
  )
  const activeAgents = status?.activeAgentCount ?? 0

  const invalidateArchivedWorkspaceCaches = () => {
    void utils.ergatai.listArchivedWorkspaces.invalidate()
    void utils.ergatai.listManagedWorkspaces.invalidate()
  }

  const restoreMutation = trpc.ergatai.restoreManagedWorkspace.useMutation({
    onSuccess: () => {
      toast.success("Workspace restored")
      onWorkspaceRestored?.(workspace.id)
      invalidateArchivedWorkspaceCaches()
    },
    onError: error => toast.error("Failed to restore workspace", {
      description: error.message,
    }),
  })

  const deleteMutation = trpc.ergatai.deleteManagedWorkspace.useMutation({
    onSuccess: () => {
      toast.success("Workspace deleted (cleanup runs in background)")
      setDeleteDialogOpen(false)
      onWorkspaceDeleted?.(workspace.id)
      invalidateArchivedWorkspaceCaches()
      void utils.chats.list.invalidate()
    },
    onError: error => toast.error("Failed to delete workspace", {
      description: error.message,
    }),
  })

  const handleSelect = useCallback(() => onWorkspaceSelect?.(workspace.id), [
    onWorkspaceSelect,
    workspace.id,
  ])
  const handleDelete = useCallback(
    () => deleteMutation.mutate({ id: workspace.id, force: false }),
    [deleteMutation, workspace.id],
  )
  const handleRestore = useCallback(
    () => restoreMutation.mutate({ workspaceId: workspace.id }),
    [restoreMutation, workspace.id],
  )

  return (
    <div
      className={cn(
        "group flex items-start gap-1 rounded-lg pr-1 transition-colors",
        isSelected
          ? "bg-foreground/10 text-foreground"
          : "text-foreground/80 hover:bg-foreground/5",
      )}
    >
      <button
        type="button"
        onClick={handleSelect}
        className="min-w-0 flex-1 rounded-lg px-2 py-2 text-left"
      >
        <div className="flex items-center justify-between gap-2">
          <div className="truncate text-sm font-medium">
            {workspace.name || i18n.t("Workspace {{id}}", { id: workspace.id.slice(0, 8) })}
          </div>
        </div>
      </button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={i18n.t("Manage archived workspace {{name}}", { name: workspace.name || workspace.id })}
            className="mt-2 rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-foreground/10 hover:text-foreground focus:opacity-100 group-hover:opacity-100"
          >
            <MoreVertical className="h-3.5 w-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[180px]">
          <DropdownMenuItem
            disabled={restoreMutation.isPending}
            onSelect={handleRestore}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            {restoreMutation.isPending ? "Restoring..." : "Restore"}
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          <DropdownMenuItem
            onSelect={handleDeleteOpen}
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <WorkspaceDeleteDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        title={i18n.t('Delete archived workspace?')}
        description={
          <>
            This permanently removes the archived workspace record and its project
            registrations. It does not delete project directories or worktree files
            from disk. This action cannot be undone.
          </>
        }
        activeAgents={activeAgents}
        isPending={deleteMutation.isPending}
        onConfirm={handleDelete}
      />
    </div>
  )
})

ArchivedWorkspaceItem.displayName = "ArchivedWorkspaceItem"

export const ArchivedWorkspaceList = memo(({
  searchQuery = "",
  collaborationMode,
  onWorkspaceSelect,
  onWorkspaceRestored,
  onWorkspaceDeleted,
  selectedWorkspaceId,
}: ArchivedWorkspaceListProps) => {
  const [isOpen, setIsOpen] = useState(false) // collapsed by default

  // Stabilize callbacks so `memo` on `ArchivedWorkspaceItem` is effective
  const handleWorkspaceSelect = useCallback(
    (workspaceId: string) => onWorkspaceSelect?.(workspaceId),
    [onWorkspaceSelect],
  )
  const handleWorkspaceRestored = useCallback(
    (workspaceId: string) => onWorkspaceRestored?.(workspaceId),
    [onWorkspaceRestored],
  )
  const handleWorkspaceDeleted = useCallback(
    (workspaceId: string) => onWorkspaceDeleted?.(workspaceId),
    [onWorkspaceDeleted],
  )

  const { data: workspaces, isLoading } =
    trpc.ergatai.listArchivedWorkspaces.useQuery({ collaborationMode })

  // Backend already filters by `status` and `collaborationMode`, so only the
  // search query needs client-side matching. Wrapped in `useMemo` to avoid
  // recomputing on every render.
  const filteredWorkspaces = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    if (!query) return workspaces ?? []
    return (workspaces ?? []).filter((workspace) =>
      `${workspace.name ?? ""} ${workspace.workDir}`.toLowerCase().includes(query),
    )
  }, [workspaces, searchQuery])

  return (
    <div className="space-y-1.5">
      <button
        type="button"
        onClick={() => setIsOpen((current) => !current)}
        aria-expanded={isOpen}
        className="flex h-7 w-full items-center justify-between rounded-lg px-2 text-left text-sm font-medium text-foreground/80 transition-colors hover:bg-foreground/5 hover:text-foreground"
      >
        <span>{i18n.t('Archived Workspaces')}</span>
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 flex-shrink-0 text-muted-foreground transition-transform duration-200",
            !isOpen && "-rotate-90",
          )}
        />
      </button>

      {isOpen && isLoading && (
        <div className="px-2 py-3 text-sm text-muted-foreground">
          Loading archived workspaces...
        </div>
      )}

      {isOpen && !isLoading && filteredWorkspaces.length > 0 && (
        <div className="space-y-1">
          {filteredWorkspaces.map(workspace => (
            <ArchivedWorkspaceItem
              key={workspace.id}
              workspace={workspace}
              selectedWorkspaceId={selectedWorkspaceId}
              onWorkspaceSelect={handleWorkspaceSelect}
              onWorkspaceRestored={handleWorkspaceRestored}
              onWorkspaceDeleted={handleWorkspaceDeleted}
            />
          ))}
        </div>
      )}
    </div>
  )
})

ArchivedWorkspaceList.displayName = "ArchivedWorkspaceList"