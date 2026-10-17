import { memo, useState } from "react"
import { ChevronDown, MoreVertical, RotateCcw, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { trpc } from "../../lib/trpc"
import { cn } from "../../lib/utils"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../components/ui/alert-dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu"
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
  const isSelected = selectedWorkspaceId === workspace.id

  const restoreMutation = trpc.ergatai.restoreManagedWorkspace.useMutation({
    onSuccess: () => {
      toast.success("Workspace restored")
      onWorkspaceRestored?.(workspace.id)
      void utils.ergatai.listArchivedWorkspaces.invalidate()
      void utils.ergatai.listManagedWorkspaces.invalidate()
    },
    onError: error => toast.error("Failed to restore workspace", {
      description: error.message,
    }),
  })

  const deleteMutation = trpc.ergatai.deleteManagedWorkspace.useMutation({
    onSuccess: () => {
      toast.success("Workspace deleted")
      setDeleteDialogOpen(false)
      onWorkspaceDeleted?.(workspace.id)
      void utils.ergatai.listArchivedWorkspaces.invalidate()
      void utils.ergatai.listManagedWorkspaces.invalidate()
      void utils.chats.list.invalidate()
    },
    onError: error => toast.error("Failed to delete workspace", {
      description: error.message,
    }),
  })

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
        onClick={() => onWorkspaceSelect?.(workspace.id)}
        className="min-w-0 flex-1 rounded-lg px-2 py-2 text-left"
      >
        <div className="flex items-center justify-between gap-2">
          <div className="truncate text-sm font-medium">
            {workspace.name || `Workspace ${workspace.id.slice(0, 8)}`}
          </div>
        </div>
      </button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`Manage archived workspace ${workspace.name || workspace.id}`}
            className="mt-2 rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-foreground/10 hover:text-foreground focus:opacity-100 group-hover:opacity-100"
          >
            <MoreVertical className="h-3.5 w-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[180px]">
          <DropdownMenuItem
            disabled={restoreMutation.isPending}
            onSelect={() => restoreMutation.mutate({ workspaceId: workspace.id })}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            {restoreMutation.isPending ? "Restoring..." : "Restore"}
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault()
              setDeleteDialogOpen(true)
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete archived workspace?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the archived workspace record and its project
              registrations. It does not delete project directories or worktree files
              from disk. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleteMutation.isPending}
              onClick={() => deleteMutation.mutate({ id: workspace.id, force: false })}
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
  const [isOpen, setIsOpen] = useState(false) // 默认折叠

  const { data: workspaces, isLoading } =
    trpc.ergatai.listArchivedWorkspaces.useQuery({ collaborationMode })

  const filteredWorkspaces = (workspaces ?? []).filter((workspace) => {
    if (workspace.collaborationMode !== collaborationMode) return false
    const query = searchQuery.trim().toLowerCase()
    if (!query) return true
    return `${workspace.name ?? ""} ${workspace.workDir}`
      .toLowerCase()
      .includes(query)
  })

  return (
    <div className="space-y-1.5">
      <button
        type="button"
        onClick={() => setIsOpen((current) => !current)}
        aria-expanded={isOpen}
        className="flex h-7 w-full items-center justify-between rounded-lg px-2 text-left text-sm font-medium text-foreground/80 transition-colors hover:bg-foreground/5 hover:text-foreground"
      >
        <span>Archived Workspaces</span>
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
              onWorkspaceSelect={onWorkspaceSelect}
              onWorkspaceRestored={onWorkspaceRestored}
              onWorkspaceDeleted={onWorkspaceDeleted}
            />
          ))}
        </div>
      )}

      {isOpen && !isLoading && filteredWorkspaces.length === 0 && (
        <div className="px-2 py-3 text-sm text-muted-foreground/60">
          No archived workspaces
        </div>
      )}
    </div>
  )
})

ArchivedWorkspaceList.displayName = "ArchivedWorkspaceList"
