import { memo, useState, useCallback } from "react"
import { Archive, ChevronDown, MoreVertical, Pencil, Trash2 } from "lucide-react"
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
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu"
import type { ErgataiWorkspace } from "../../../main/lib/trpc/routers/ergatai"
import { WorkspaceEditDialog } from "./workspace-edit-dialog"

type WorkspaceListProps = {
  searchQuery?: string
  collaborationMode: "supervisor" | "group"
  onWorkspaceSelect?: (workspaceId: string) => void
  onWorkspaceDeleted?: (workspaceId: string) => void
  selectedWorkspaceId?: string | null
}

const WorkspaceItem = memo(({
  workspace,
  selectedWorkspaceId,
  onWorkspaceSelect,
  onWorkspaceDeleted,
}: {
  workspace: ErgataiWorkspace
  selectedWorkspaceId?: string | null
  onWorkspaceSelect?: (workspaceId: string) => void
  onWorkspaceDeleted?: (workspaceId: string) => void
}) => {
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [editDialogOpen, setEditDialogOpen] = useState(false)
  const utils = trpc.useUtils()
  const isSelected = selectedWorkspaceId === workspace.id
  const { data: status } = trpc.ergatai.workspaceStatus.useQuery(
    { id: workspace.id },
    { staleTime: 10_000 },
  )

  const setDefaultProjectMutation = trpc.ergatai.updateManagedWorkspace.useMutation({
    onSuccess: () => {
      toast.success("Default project updated")
      void utils.ergatai.listManagedWorkspaces.invalidate()
      void utils.ergatai.workspaceStatus.invalidate({ id: workspace.id })
    },
    onError: error => toast.error("Failed to update default project", {
      description: error.message,
    }),
  })

  const archiveMutation = trpc.ergatai.archiveManagedWorkspace.useMutation({
    onSuccess: () => {
      toast.success("Workspace archived")
      onWorkspaceDeleted?.(workspace.id)
      void utils.ergatai.listManagedWorkspaces.invalidate()
      void utils.ergatai.listArchivedWorkspaces.invalidate()
    },
    onError: error => toast.error("Failed to archive workspace", {
      description: error.message,
    }),
  })

  const deleteMutation = trpc.ergatai.deleteManagedWorkspace.useMutation({
    onSuccess: () => {
      toast.success("Workspace deleted")
      setDeleteDialogOpen(false)
      onWorkspaceDeleted?.(workspace.id)
      void utils.ergatai.listManagedWorkspaces.invalidate()
      void utils.chats.list.invalidate()
    },
    onError: error => toast.error("Failed to delete workspace", {
      description: error.message,
    }),
  })

  const activeAgents = status?.activeAgentCount ?? 0
  const blockers = [
    activeAgents > 0 && `${activeAgents} active agent(s)`,
  ].filter((blocker): blocker is string => Boolean(blocker))

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
          {status && (
            <span className="flex-shrink-0 text-[10px] text-muted-foreground/60">
              {status.conversationCount} chats
            </span>
          )}
        </div>

        {status && !status.healthy && (
          <div className="text-[10px] text-destructive">workdir missing</div>
        )}
      </button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`Manage workspace ${workspace.name || workspace.id}`}
            className="mt-2 rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-foreground/10 hover:text-foreground focus:opacity-100 group-hover:opacity-100"
          >
            <MoreVertical className="h-3.5 w-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[180px]">
          <DropdownMenuItem
            onSelect={() => setEditDialogOpen(true)}
          >
            <Pencil className="h-3.5 w-3.5" />
            Edit
          </DropdownMenuItem>

          {(workspace.projects?.length ?? 0) > 1 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>Set default project</DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  {(workspace.projects ?? []).map((project) => (
                    <DropdownMenuItem
                      key={project.projectId}
                      disabled={project.isDefault || setDefaultProjectMutation.isPending}
                      onSelect={() => setDefaultProjectMutation.mutate({
                        id: workspace.id,
                        defaultProjectId: project.projectId,
                      })}
                    >
                      {project.projectName}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            </>
          )}

          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={archiveMutation.isPending}
            onSelect={() => archiveMutation.mutate({ workspaceId: workspace.id })}
          >
            <Archive className="h-3.5 w-3.5" />
            {archiveMutation.isPending ? "Archiving..." : "Archive"}
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
            <AlertDialogTitle>Delete workspace?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the workspace record and its project registrations.
              It does not delete project directories or worktree files from disk.
            </AlertDialogDescription>
          </AlertDialogHeader>

          {blockers.length > 0 && (
            <div className="mx-5 mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-foreground">
              <p className="font-medium">Resolve these before deleting:</p>
              <ul className="mt-1 list-disc pl-4">
                {blockers.map((blocker) => (
                  <li key={blocker}>{blocker}</li>
                ))}
              </ul>
            </div>
          )}

          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={
                blockers.length > 0 ||
                !status ||
                deleteMutation.isPending
              }
              onClick={() => deleteMutation.mutate({ id: workspace.id, force: false })}
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <WorkspaceEditDialog
        open={editDialogOpen}
        onOpenChange={setEditDialogOpen}
        workspaceId={workspace.id}
        workspaceName={workspace.name || ""}
      />
    </div>
  )
})

WorkspaceItem.displayName = "WorkspaceItem"

export const WorkspaceList = memo(({
  searchQuery = "",
  collaborationMode,
  onWorkspaceSelect,
  onWorkspaceDeleted,
  selectedWorkspaceId,
}: WorkspaceListProps) => {
  const [isOpen, setIsOpen] = useState(true)
  const { data: workspaces, isLoading } =
    trpc.ergatai.listManagedWorkspaces.useQuery({ collaborationMode })

  // Stabilize callbacks so `memo` on `WorkspaceItem` is effective
  const handleWorkspaceSelect = useCallback(
    (workspaceId: string) => onWorkspaceSelect?.(workspaceId),
    [onWorkspaceSelect],
  )
  const handleWorkspaceDeleted = useCallback(
    (workspaceId: string) => onWorkspaceDeleted?.(workspaceId),
    [onWorkspaceDeleted],
  )

  const query = searchQuery.trim().toLowerCase()
  const filteredWorkspaces = (workspaces ?? []).filter((workspace) => {
    // Filter out archived workspaces
    if (workspace.status === "archived") return false
    if (workspace.collaborationMode !== collaborationMode) return false
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
        <span>Workspaces</span>
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 flex-shrink-0 text-muted-foreground transition-transform duration-200",
            !isOpen && "-rotate-90",
          )}
        />
      </button>

      {isOpen && isLoading && (
        <div className="px-2 py-3 text-sm text-muted-foreground">
          Loading workspaces...
        </div>
      )}

      {isOpen && !isLoading && filteredWorkspaces.length > 0 && (
        <div className="space-y-1">
          {filteredWorkspaces.map(workspace => (
            <WorkspaceItem
              key={workspace.id}
              workspace={workspace}
              selectedWorkspaceId={selectedWorkspaceId}
              onWorkspaceSelect={handleWorkspaceSelect}
              onWorkspaceDeleted={handleWorkspaceDeleted}
            />
          ))}
        </div>
      )}
    </div>
  )
})

WorkspaceList.displayName = "WorkspaceList"
