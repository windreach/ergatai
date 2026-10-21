import { useState, useMemo } from "react"
import { useAtom } from "jotai"
import { toast } from "sonner"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../../../components/ui/popover"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "../../../components/ui/command"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog"
import { Input } from "../../../components/ui/input"
import { Button } from "../../../components/ui/button"
import { IconChevronDown, CheckIcon, FolderPlusIcon, GitHubIcon, FolderFilledIcon } from "../../../components/ui/icons"
import { ProjectIcon } from "../../../components/ui/project-icon"
import { cn } from "../../../lib/utils"
import { trpc } from "../../../lib/trpc"
import { selectedWorkspaceAtom } from "../atoms"
import {
  dedupeByPath,
  getPathDeduplicatedNames,
} from "../lib/workspace-naming"
import { useCollaborationMode } from "../collaboration/use-collaboration-mode"

interface WorkspaceSelectorProps {
  triggerClassName?: string
  contentClassName?: string
  matchTriggerWidth?: boolean
  onWorkspaceSelected?: (workspace: { id: string; name: string; path: string }) => void
}

export function WorkspaceSelector({
  triggerClassName,
  contentClassName,
  matchTriggerWidth = false,
  onWorkspaceSelected,
}: WorkspaceSelectorProps = {}) {
  const [selectedWorkspace, setSelectedWorkspace] = useAtom(selectedWorkspaceAtom)
  const [open, setOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")
  const [githubDialogOpen, setGithubDialogOpen] = useState(false)
  const [githubUrl, setGithubUrl] = useState("")
  const { mode: collaborationMode } = useCollaborationMode()

  // Fetch projects from DB
  const { data: projects, isLoading: isLoadingProjects } = trpc.projects.list.useQuery(undefined, { staleTime: Infinity })

  // Fetch workspaces to check for existing default workspace
  const { data: workspaces } = trpc.ergatai.listManagedWorkspaces.useQuery({ collaborationMode })

  const uniqueProjects = useMemo(
    () => dedupeByPath(projects ?? []),
    [projects],
  )

  const filteredProjects = useMemo(() => {
    if (!searchQuery.trim()) return uniqueProjects
    const query = searchQuery.toLowerCase()
    return uniqueProjects.filter(
      (p) =>
        p.name.toLowerCase().includes(query) ||
        p.path.toLowerCase().includes(query),
    )
  }, [searchQuery, uniqueProjects])

  const projectDisplayNames = useMemo(
    () => getPathDeduplicatedNames(uniqueProjects),
    [uniqueProjects],
  )

  // Get tRPC utils for cache management
  const utils = trpc.useUtils()

  // Open folder mutation
  const openFolder = trpc.projects.openFolder.useMutation({
    onSuccess: (project) => {
      if (project) {
        // Optimistically update the projects list cache to prevent validation failures
        utils.projects.list.setData(undefined, (oldData) => {
          if (!oldData) return [project]
          const exists = oldData.some((p) => p.id === project.id)
          if (exists) {
            return oldData.map((p) =>
              p.id === project.id ? { ...p, updatedAt: project.updatedAt } : p,
            )
          }
          return [project, ...oldData]
        })

        setSelectedWorkspace({
          id: project.id,
          name: project.name,
          path: project.path,
          gitRemoteUrl: project.gitRemoteUrl,
          gitProvider: project.gitProvider as
            | "github"
            | "gitlab"
            | "bitbucket"
            | null,
          gitOwner: project.gitOwner,
          gitRepo: project.gitRepo,
        })
        onWorkspaceSelected?.({ id: project.id, name: project.name, path: project.path })
      }
    },
  })

  // Default workspace mutation - quick start without selecting project
  const defaultWorkspace = trpc.ergatai.createWorkspace.useMutation({
    onSuccess: async (workspace) => {
      toast.success("Default workspace created")

      // Refresh both caches before navigating. `projects.list` uses
      // staleTime: Infinity, so `fetch()` alone can return the old list and
      // make NewChatForm treat the newly created project as invalid.
      await utils.ergatai.listManagedWorkspaces.invalidate()
      await utils.projects.list.invalidate()
      const freshProjects = await utils.projects.list.fetch()
      setOpen(false)

      // Use the actual project ID from the created workspace, not workspace.id
      // workspace.id is a ws_... format, not a proj_... format
      const projectId = workspace.defaultProjectId
      if (!projectId) {
        toast.error("Workspace created but no project found", {
          description: "Please refresh and try again",
        })
        return
      }

      // Sync selectedWorkspace with the created workspace's default project
      // This is critical for NewChatForm to show the input form instead of WorkspaceSelector
      const project = freshProjects.find(p => p.id === projectId)
      if (!project) {
        toast.error("Workspace created but project not found", {
          description: "Please refresh the page and try again",
        })
        return
      }

      setSelectedWorkspace({
        id: project.id,
        name: project.name,
        path: project.path,
        gitRemoteUrl: project.gitRemoteUrl,
        gitProvider: project.gitProvider as NonNullable<typeof selectedWorkspace>["gitProvider"],
        gitOwner: project.gitOwner,
        gitRepo: project.gitRepo,
      })

      // Keep the aggregate projects cache in sync for NewChatForm validation.
      utils.projects.list.setData(undefined, oldData => {
        if (oldData?.some(p => p.id === project.id)) {
          return oldData
        }
        return [project, ...(oldData ?? [])]
      })

      onWorkspaceSelected?.({
        id: projectId,
        name: workspace.name ?? "Default Workspace",
        path: project.path,
      })
    },
    onError: (error) => {
      toast.error("Failed to create default workspace", { description: error.message })
    },
  })

  const handleDefaultWorkspace = async () => {
    // Check if a default workspace already exists to avoid duplicates
    const existingDefault = workspaces?.find(
      (ws) => ws.name === "Default Workspace" && ws.collaborationMode === collaborationMode,
    )
    if (existingDefault) {
      toast.info("Default workspace already exists")

      // Use defaultProjectId directly, don't fallback to workspace.id (ws_... format)
      const projectId = existingDefault.defaultProjectId
      if (!projectId) {
        toast.error("Default workspace has no project", {
          description: "Please refresh and try again",
        })
        setOpen(false)
        return
      }

      onWorkspaceSelected?.({
        id: projectId,
        name: existingDefault.name ?? "Default Workspace",
        path: existingDefault.workDir,
      })
      setOpen(false)
      return
    }

    await defaultWorkspace.mutateAsync({
      name: "Default Workspace",
      workDir: "~/.ergatai",
      projectPath: "~/.ergatai",
      projectName: "Default Project",
      collaborationMode,
    })
  }

  // Clone from GitHub mutation
  const cloneFromGitHub = trpc.projects.cloneFromGitHub.useMutation({
    onSuccess: (project) => {
      if (project) {
        utils.projects.list.setData(undefined, (oldData) => {
          if (!oldData) return [project]
          const exists = oldData.some((p) => p.id === project.id)
          if (exists) {
            return oldData.map((p) =>
              p.id === project.id ? { ...p, updatedAt: project.updatedAt } : p,
            )
          }
          return [project, ...oldData]
        })

        setSelectedWorkspace({
          id: project.id,
          name: project.name,
          path: project.path,
          gitRemoteUrl: project.gitRemoteUrl,
          gitProvider: project.gitProvider as
            | "github"
            | "gitlab"
            | "bitbucket"
            | null,
          gitOwner: project.gitOwner,
          gitRepo: project.gitRepo,
        })
        setGithubDialogOpen(false)
        setGithubUrl("")
        onWorkspaceSelected?.({ id: project.id, name: project.name, path: project.path })
      }
    },
  })

  const handleOpenFolder = async () => {
    setOpen(false)
    await openFolder.mutateAsync()
  }

  const handleCloneFromGitHub = async () => {
    if (!githubUrl.trim()) return
    await cloneFromGitHub.mutateAsync({ repoUrl: githubUrl.trim() })
  }

  const handleSelectProject = (projectId: string) => {
    const project = projects?.find((p) => p.id === projectId)
    if (project) {
      setSelectedWorkspace({
        id: project.id,
        name: project.name,
        path: project.path,
        gitRemoteUrl: project.gitRemoteUrl,
        gitProvider: project.gitProvider as
          | "github"
          | "gitlab"
          | "bitbucket"
          | null,
        gitOwner: project.gitOwner,
        gitRepo: project.gitRepo,
      })
      onWorkspaceSelected?.({ id: project.id, name: project.name, path: project.path })
      setOpen(false)
    }
  }

  // Validate selected project still exists and use latest DB data (e.g. renamed project)
  // While loading, trust localStorage value to prevent showing "Select repo" on app restart
  const validSelection = useMemo(() => {
    if (!selectedWorkspace) return null
    // While loading, trust localStorage value
    if (isLoadingProjects) return selectedWorkspace
    // After loading, validate against DB and use fresh data
    if (!projects) return null
    const dbProject = projects.find((p) => p.id === selectedWorkspace.id)
    if (!dbProject) return null
    return {
      ...selectedWorkspace,
      name: dbProject.name,
    }
  }, [selectedWorkspace, projects, isLoadingProjects])

  return (
    <>
    <Popover
      open={open}
      onOpenChange={(isOpen) => {
        setOpen(isOpen)
        if (!isOpen) setSearchQuery("")
      }}
    >
      <PopoverTrigger asChild>
        <button
          className={cn(
            "flex items-center gap-1.5 px-2 py-1 text-sm text-muted-foreground hover:text-foreground transition-[background-color,color] duration-150 ease-out rounded-md hover:bg-muted/50 outline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring/70",
            triggerClassName,
          )}
          type="button"
        >
          <ProjectIcon
            project={validSelection}
            className="h-4 w-4"
          />
          <span className="truncate max-w-[120px]">
            {validSelection
              ? projectDisplayNames.get(validSelection.id) ?? validSelection.name
              : "Select workspace"}
          </span>
          <IconChevronDown className="h-3 w-3 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className={cn("p-0", contentClassName)}
        align={matchTriggerWidth ? "center" : "start"}
        style={
          matchTriggerWidth
            ? {
                width: "var(--radix-popover-trigger-width)",
                minWidth: 0,
              }
            : undefined
        }
      >
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search workspaces..."
            value={searchQuery}
            onValueChange={setSearchQuery}
          />
          <CommandList className="max-h-[360px] overflow-y-auto">
            {isLoadingProjects ? (
              <div className="px-2.5 py-4 text-center text-sm text-muted-foreground">
                Loading...
              </div>
            ) : filteredProjects.length > 0 ? (
              <CommandGroup>
                {filteredProjects.map((project) => {
                  const isSelected = validSelection?.id === project.id
                  return (
                    <CommandItem
                      key={project.id}
                      value={`${project.name} ${project.path}`}
                      onSelect={() => handleSelectProject(project.id)}
                      className="gap-2"
                    >
                      <ProjectIcon
                        project={project}
                        className="h-4 w-4"
                      />
                      <span className="truncate flex-1">
                        {projectDisplayNames.get(project.id) ?? project.name}
                      </span>
                      {isSelected && (
                        <CheckIcon className="h-4 w-4 shrink-0" />
                      )}
                    </CommandItem>
                  )
                })}
              </CommandGroup>
            ) : (
              <CommandEmpty>No projects found.</CommandEmpty>
            )}
          </CommandList>
          <div className="border-t border-border/50 py-1">
            {/* Default Workspace - Quick Start */}
            <button
              onClick={handleDefaultWorkspace}
              disabled={defaultWorkspace.isPending}
              className="flex items-center gap-1.5 min-h-[32px] py-[5px] px-1.5 mx-1 w-[calc(100%-8px)] rounded-md text-sm cursor-default select-none outline-none dark:hover:bg-neutral-800 hover:text-foreground transition-colors border-b border-border/30"
            >
              <FolderFilledIcon className="h-4 w-4 text-muted-foreground" />
              <span>{defaultWorkspace.isPending ? "Creating..." : "Default Workspace"}</span>
            </button>
            <button
              onClick={handleOpenFolder}
              disabled={openFolder.isPending}
              className="flex items-center gap-1.5 min-h-[32px] py-[5px] px-1.5 mx-1 w-[calc(100%-8px)] rounded-md text-sm cursor-default select-none outline-none dark:hover:bg-neutral-800 hover:text-foreground transition-colors"
            >
              <FolderPlusIcon className="h-4 w-4 text-muted-foreground" />
              <span>{openFolder.isPending ? "Adding..." : "Add repository"}</span>
            </button>
            <button
              onClick={() => {
                setOpen(false)
                setGithubDialogOpen(true)
              }}
              className="flex items-center gap-1.5 min-h-[32px] py-[5px] px-1.5 mx-1 w-[calc(100%-8px)] rounded-md text-sm cursor-default select-none outline-none dark:hover:bg-neutral-800 hover:text-foreground transition-colors"
            >
              <GitHubIcon className="h-4 w-4 text-muted-foreground" />
              <span>Add from GitHub</span>
            </button>
          </div>
        </Command>
      </PopoverContent>
    </Popover>

    <Dialog open={githubDialogOpen} onOpenChange={setGithubDialogOpen}>
      <DialogContent className="w-[400px] p-0 gap-0 overflow-hidden">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            handleCloneFromGitHub()
          }}
        >
          <div className="p-6">
            <h2 className="text-xl font-semibold mb-4">
              Clone from GitHub
            </h2>
            <Input
              placeholder="owner/repo or https://github.com/..."
              value={githubUrl}
              onChange={(e) => setGithubUrl(e.target.value)}
              className="w-full h-11 text-sm"
              autoFocus
            />
          </div>
          <div className="bg-muted p-4 flex justify-between border-t border-border">
            <Button
              type="button"
              onClick={() => setGithubDialogOpen(false)}
              variant="ghost"
              className="rounded-md"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!githubUrl.trim() || cloneFromGitHub.isPending}
              variant="default"
              className="rounded-md"
            >
              {cloneFromGitHub.isPending ? "Cloning..." : "Clone"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
    </>
  )
}
