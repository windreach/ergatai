import { useState, useCallback } from "react"
import { Folder, FolderPlus, X } from "lucide-react"
import { toast } from "sonner"

import { trpc } from "../../lib/trpc"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog"
import { Button } from "../../components/ui/button"
import { Input } from "../../components/ui/input"

type WorkspaceEditDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaceId: string
  workspaceName: string
}

export function WorkspaceEditDialog({
  open,
  onOpenChange,
  workspaceId,
  workspaceName,
}: WorkspaceEditDialogProps) {
  const [name, setName] = useState(workspaceName)
  const [saving, setSaving] = useState(false)

  const utils = trpc.useUtils()

  // Fetch projects from backend API (source of truth)
  const { data: projects = [] } = trpc.ergatai.listWorkspaceProjects.useQuery(
    { id: workspaceId },
    { enabled: open },
  )

  const pickFolderMutation = trpc.projects.pickFolder.useMutation()
  const updateNameMutation = trpc.ergatai.updateManagedWorkspace.useMutation()
  const registerProjectMutation = trpc.ergatai.registerWorkspaceProject.useMutation()
  const removeProjectMutation = trpc.ergatai.removeWorkspaceProject.useMutation()

  const invalidateWorkspaceCaches = () => {
    void utils.ergatai.listWorkspaceProjects.invalidate({ id: workspaceId })
    void utils.ergatai.listManagedWorkspaces.invalidate()
    void utils.ergatai.workspaceStatus.invalidate({ id: workspaceId })
  }

  const handleAddFolder = useCallback(async () => {
    const folderPath = await pickFolderMutation.mutateAsync()
    if (!folderPath) return

    // Cross-platform path parsing: split on both / and \
    const folderName = folderPath.split(/[/\\]/).pop() || folderPath

    // Check if already added
    if (projects.some((p) => p.projectName === folderName)) {
      toast.error("Folder already added")
      return
    }

    registerProjectMutation.mutate(
      { id: workspaceId, projectPath: folderPath, projectName: folderName },
      {
        onSuccess: invalidateWorkspaceCaches,
        onError: (error) => {
          toast.error("Failed to add folder", { description: error.message })
        },
      },
    )
  }, [pickFolderMutation, projects, workspaceId, registerProjectMutation, utils])

  const handleRemoveFolder = useCallback(
    (project: { projectId: string; projectName: string; isDefault: boolean }) => {
      removeProjectMutation.mutate(
        { id: workspaceId, projectId: project.projectId },
        {
          onSuccess: invalidateWorkspaceCaches,
          onError: (error) => {
            toast.error("Failed to remove folder", { description: error.message })
          },
        },
      )
    },
    [workspaceId, removeProjectMutation, utils],
  )

  const handleSave = useCallback(async () => {
    setSaving(true)
    try {
      await updateNameMutation.mutateAsync({ id: workspaceId, name: name.trim() || undefined })
      invalidateWorkspaceCaches()
      toast.success("Workspace updated")
      onOpenChange(false)
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error"
      toast.error("Failed to save", { description: message })
    } finally {
      setSaving(false)
    }
  }, [workspaceId, name, updateNameMutation, utils, onOpenChange])

  const handleOpenChange = useCallback(
    (newOpen: boolean) => {
      if (!newOpen) {
        // Reset name on close
        setName(workspaceName)
      }
      onOpenChange(newOpen)
    },
    [workspaceName, onOpenChange],
  )

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>Edit Workspace</DialogTitle>
          <DialogDescription>
            Change the workspace name and manage source folders.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Name input */}
          <div className="relative">
            <Folder className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Workspace name"
              className="pl-9"
            />
          </div>

          {/* Source folders */}
          <div className="space-y-2">
            <div className="text-xs font-medium text-muted-foreground">Source Folders</div>
            <div className="space-y-1.5">
              {(projects ?? []).map((project) => (
                <div
                  key={project.projectId}
                  className="flex items-center justify-between rounded-md border bg-background px-3 py-2"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <Folder className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                    <span className="truncate text-sm">{project.projectName}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleRemoveFolder(project)}
                    className="flex-shrink-0 rounded p-0.5 text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>

            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleAddFolder}
              disabled={pickFolderMutation.isPending || registerProjectMutation.isPending}
              className="w-full"
            >
              <FolderPlus className="mr-1.5 h-3.5 w-3.5" />
              Add Folder
            </Button>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
