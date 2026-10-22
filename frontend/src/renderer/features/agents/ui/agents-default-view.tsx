"use client"

import { useCallback } from "react"
import { useAtom, useAtomValue } from "jotai"
import { toast } from "sonner"

import { Logo } from "@/components/ui/logo"
import { WorkspaceSelector } from "../components/workspace-selector"
import { selectedWorkspaceIdAtom, showNewChatFormAtom } from "../atoms"
import { agentsUnseenChangesAtom } from "../atoms"
import { agentsSidebarOpenAtom } from "../atoms"
import { AgentsHeaderControls } from "./agents-header-controls"
import { useCollaborationMode } from "../collaboration/use-collaboration-mode"
import { trpc } from "../../../lib/trpc"

interface AgentsDefaultViewProps {
  onWorkspaceCreated?: (workspaceId: string) => void
}

export function AgentsDefaultView({
  onWorkspaceCreated,
}: AgentsDefaultViewProps) {
  const [, setSelectedWorkspaceId] = useAtom(selectedWorkspaceIdAtom)
  const [, setShowNewChatForm] = useAtom(showNewChatFormAtom)
  const unseenChanges = useAtomValue(agentsUnseenChangesAtom)
  const [sidebarOpen, setSidebarOpen] = useAtom(agentsSidebarOpenAtom)
  const { mode: collaborationMode } = useCollaborationMode()

  const utils = trpc.useUtils()

  // Create workspace mutation
  const createWorkspaceMutation = trpc.ergatai.createWorkspace.useMutation({
    onSuccess: (data, variables) => {
      toast.success("Workspace created successfully")
      utils.ergatai.listManagedWorkspaces.invalidate()
      setSelectedWorkspaceId(data.id)
      setShowNewChatForm(true)
      onWorkspaceCreated?.(data.id)
    },
    onError: (error) => {
      toast.error("Failed to create workspace", { description: error.message })
    },
  })

  // Handle workspace selection -> find or create workspace.
  // Wrapped in try/catch: prop type is `(workspace) => void` (synchronous), so
  // the caller in WorkspaceSelector won't await this or catch rejections.
  const handleWorkspaceSelected = useCallback(
    async (workspace: { id: string; name: string; path: string }) => {
      try {
        // Fetch fresh workspace list to avoid creating duplicates due to stale cache
        const freshWorkspaces = await utils.ergatai.listManagedWorkspaces.fetch({
          collaborationMode,
        })
        const freshModeWorkspaces = freshWorkspaces.filter(
          (ws) => ws.collaborationMode === collaborationMode,
        )

        // Check if workspace already exists for this project path
        const existingWorkspace = freshModeWorkspaces.find(
          (ws) => ws.workDir === workspace.path
        )
        if (existingWorkspace) {
          setSelectedWorkspaceId(existingWorkspace.id)
          setShowNewChatForm(true)
          onWorkspaceCreated?.(existingWorkspace.id)
          return
        }

        createWorkspaceMutation.mutate({
          projectId: workspace.id,
          name: workspace.name,
          workDir: workspace.path,
          collaborationMode,
        })
      } catch (err) {
        toast.error("Failed to check existing workspaces", {
          description: err instanceof Error ? err.message : "Please try again",
        })
      }
    },
    [
      collaborationMode,
      createWorkspaceMutation,
      setSelectedWorkspaceId,
      setShowNewChatForm,
      onWorkspaceCreated,
      utils.ergatai.listManagedWorkspaces,
    ],
  )

  return (
    <>
      <div className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-background">
        <div className="flex flex-shrink-0 items-center justify-between bg-background p-1.5">
          <div className="flex min-w-0 items-center gap-2">
            <AgentsHeaderControls
              isSidebarOpen={sidebarOpen}
              onToggleSidebar={() => setSidebarOpen((prev) => !prev)}
              hasUnseenChanges={unseenChanges.size > 0}
            />
          </div>

          <div className="flex items-center gap-1" />
        </div>

        <div className="flex flex-1 items-center justify-center overflow-y-auto px-6">
          <div className="w-full max-w-xl pb-10 text-center">
            <Logo className="mx-auto h-9 w-9 text-foreground" />

            <h1 className="mt-10 text-sm font-medium text-foreground">
              Choose a workspace to start multi-agent collaboration
            </h1>

            <div className="mt-5">
              <WorkspaceSelector
                triggerClassName="h-16 w-full justify-center gap-2 rounded-xl border border-border bg-background px-4 text-sm font-medium text-foreground shadow-sm hover:bg-accent/50"
                contentClassName="rounded-xl"
                matchTriggerWidth
                onWorkspaceSelected={handleWorkspaceSelected}
              />
            </div>
          </div>
        </div>
      </div>

    </>
  )
}
