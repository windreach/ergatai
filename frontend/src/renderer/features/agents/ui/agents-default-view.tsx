"use client"

import { useCallback, useMemo } from "react"
import { useAtom, useAtomValue } from "jotai"
import { toast } from "sonner"

import { Logo } from "@/components/ui/logo"
import { ProjectSelector } from "../components/project-selector"
import { selectedProjectAtom, selectedWorkspaceIdAtom, showNewChatFormAtom } from "../atoms"
import { agentsUnseenChangesAtom } from "../atoms"
import { agentsSidebarOpenAtom } from "../atoms"
import { AgentsHeaderControls } from "./agents-header-controls"
import { useCollaborationMode } from "../collaboration/use-collaboration-mode"
import { trpc } from "../../../lib/trpc"
import {
  dedupeByPath,
  getPathDeduplicatedNames,
} from "../lib/workspace-naming"

interface AgentsDefaultViewProps {
  onWorkspaceCreated?: (workspaceId: string) => void
}

export function AgentsDefaultView({
  onWorkspaceCreated,
}: AgentsDefaultViewProps) {
  const [selectedProject, setSelectedProject] = useAtom(selectedProjectAtom)
  const [, setSelectedWorkspaceId] = useAtom(selectedWorkspaceIdAtom)
  const [, setShowNewChatForm] = useAtom(showNewChatFormAtom)
  const unseenChanges = useAtomValue(agentsUnseenChangesAtom)
  const [sidebarOpen, setSidebarOpen] = useAtom(agentsSidebarOpenAtom)
  const { mode: collaborationMode } = useCollaborationMode()

  // Fetch projects from DB
  const { data: projects } = trpc.projects.list.useQuery(undefined, {
    staleTime: Infinity,
  })
  // Fetch current-mode workspaces. Workspaces are mode-owned, so a project may
  // be reused in supervisor mode and still get a separate workspace in group mode.
  const { data: workspaces } = trpc.ergatai.listManagedWorkspaces.useQuery({
    collaborationMode,
  })
  const modeWorkspaces = useMemo(
    () =>
      (workspaces ?? []).filter(
        (workspace) => workspace.collaborationMode === collaborationMode,
      ),
    [workspaces, collaborationMode],
  )

  const utils = trpc.useUtils()

  // Create workspace mutation
  const createWorkspaceMutation = trpc.ergatai.createManagedWorkspace.useMutation({
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

  // Handle project selection -> create workspace
  const handleProjectSelected = useCallback(
    (project: { id: string; name: string }) => {
      const fullProject = projects?.find((p) => p.id === project.id)
      if (!fullProject) return

      // Check if workspace already exists for this project path
      const existingWorkspace = modeWorkspaces?.find(
        (ws) => ws.workDir === fullProject.path
      )
      if (existingWorkspace) {
        setSelectedWorkspaceId(existingWorkspace.id)
        setShowNewChatForm(true)
        onWorkspaceCreated?.(existingWorkspace.id)
        return
      }

      // Generate unique workspace name using path deduplication
      const uniqueProjects = dedupeByPath(projects ?? [])
      const displayNames = getPathDeduplicatedNames(uniqueProjects)
      const workspaceName = displayNames.get(fullProject.id) ?? fullProject.name

      createWorkspaceMutation.mutate({
        projectId: fullProject.id,
        name: workspaceName,
        workDir: fullProject.path,
        collaborationMode,
      })
    },
    [
      projects,
      modeWorkspaces,
      collaborationMode,
      createWorkspaceMutation,
      setSelectedWorkspaceId,
      setShowNewChatForm,
      onWorkspaceCreated,
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
              <ProjectSelector
                triggerClassName="h-16 w-full justify-center gap-2 rounded-xl border border-border bg-background px-4 text-sm font-medium text-foreground shadow-sm hover:bg-accent/50"
                contentClassName="rounded-xl"
                matchTriggerWidth
                onProjectSelected={handleProjectSelected}
              />
            </div>
          </div>
        </div>
      </div>

    </>
  )
}
