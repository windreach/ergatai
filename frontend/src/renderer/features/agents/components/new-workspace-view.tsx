import i18n from "@/lib/i18n"
"use client"

import {
  useCallback,
  useMemo,
  useState,
  type FormEvent,
} from "react"
import { useAtom, useSetAtom } from "jotai"
import { Check, Folder, Loader2, X } from "lucide-react"
import { toast } from "sonner"

import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ProjectIcon } from "@/components/ui/project-icon"
import { FolderPlusIcon } from "@/components/ui/icons"
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import { trpc } from "@/lib/trpc"
import {
  agentsConversationsSidebarModeAtom,
  agentsMobileViewModeAtom,
  desktopViewAtom,
  selectedAgentChatIdAtom,
  selectedDraftIdAtom,
  selectedWorkspaceIdAtom,
  showNewChatFormAtom,
} from "../atoms"
import { useCollaborationMode } from "../collaboration/use-collaboration-mode"
import {
  dedupeByPath,
  getPathDeduplicatedNames,
} from "../lib/workspace-naming"

/**
 * Floating New Workspace panel.
 *
 * A compact creation form: workspace name plus a multi-select project picker.
 * The first selected project becomes the workspace default; the remaining
 * selected projects are registered after creation.
 */
export function NewWorkspaceViewPage() {
  const [desktopView, setDesktopView] = useAtom(desktopViewAtom)
  const [workspaceName, setWorkspaceName] = useState("")
  const [selectedProjectIds, setSelectedProjectIds] = useState<string[]>([])
  const [projectPickerOpen, setProjectPickerOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")
  const [isCreating, setIsCreating] = useState(false)

  const setSelectedWorkspaceId = useSetAtom(selectedWorkspaceIdAtom)
  const setSelectedChatId = useSetAtom(selectedAgentChatIdAtom)
  const setSelectedDraftId = useSetAtom(selectedDraftIdAtom)
  const setShowNewChatForm = useSetAtom(showNewChatFormAtom)
  const setConversationsSidebarMode = useSetAtom(
    agentsConversationsSidebarModeAtom,
  )
  const setMobileViewMode = useSetAtom(agentsMobileViewModeAtom)

  const { mode: collaborationMode } = useCollaborationMode()
  const utils = trpc.useUtils()
  const isOpen = desktopView === "new-workspace"

  const projectsQuery = trpc.projects.list.useQuery(undefined, {
    staleTime: Infinity,
    enabled: isOpen,
  })
  const projects = projectsQuery.data ?? []

  const uniqueProjects = useMemo(() => dedupeByPath(projects), [projects])
  const projectDisplayNames = useMemo(
    () => getPathDeduplicatedNames(uniqueProjects),
    [uniqueProjects],
  )
  const filteredProjects = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    if (!query) return uniqueProjects
    return uniqueProjects.filter(
      (project) =>
        project.name.toLowerCase().includes(query) ||
        project.path.toLowerCase().includes(query),
    )
  }, [searchQuery, uniqueProjects])
  const selectedProjects = useMemo(
    () =>
      selectedProjectIds
        .map((projectId) =>
          uniqueProjects.find((project) => project.id === projectId),
        )
        .filter((project): project is (typeof uniqueProjects)[number] =>
          Boolean(project),
        ),
    [selectedProjectIds, uniqueProjects],
  )

  const resetForm = useCallback(() => {
    setWorkspaceName("")
    setSelectedProjectIds([])
    setProjectPickerOpen(false)
    setSearchQuery("")
    setIsCreating(false)
  }, [])

  const close = useCallback(() => {
    resetForm()
    setDesktopView(null)
  }, [resetForm, setDesktopView])

  const goToWorkspace = useCallback(
    (workspaceId: string) => {
      resetForm()
      setSelectedWorkspaceId(workspaceId)
      setConversationsSidebarMode("sidebar")
      setSelectedChatId(null)
      setSelectedDraftId(null)
      setShowNewChatForm(true)
      setMobileViewMode("chat")
      setDesktopView(null)
    },
    [
      resetForm,
      setConversationsSidebarMode,
      setDesktopView,
      setMobileViewMode,
      setSelectedChatId,
      setSelectedDraftId,
      setSelectedWorkspaceId,
      setShowNewChatForm,
    ],
  )

  const createWorkspaceMutation = trpc.ergatai.createWorkspace.useMutation({
    onError: (error) => {
      toast.error(i18n.t("Failed to create workspace"), {
        description: error.message,
      })
    },
  })

  const registerProjectMutation =
    trpc.ergatai.registerWorkspaceProject.useMutation()

  const openFolderMutation = trpc.projects.openFolder.useMutation({
    onSuccess: (project) => {
      if (!project) return
      utils.projects.list.setData(undefined, (oldData) => {
        if (!oldData) return [project]
        const exists = oldData.some((item) => item.id === project.id)
        if (!exists) return [project, ...oldData]
        return oldData.map((item) =>
          item.id === project.id
            ? { ...item, updatedAt: project.updatedAt }
            : item,
        )
      })
      setSelectedProjectIds((current) =>
        current.includes(project.id) ? current : [...current, project.id],
      )
    },
    onError: (error) => {
      toast.error(i18n.t("Failed to add repository"), {
        description: error.message,
      })
    },
  })

  const handleToggleProject = useCallback((projectId: string) => {
    setSelectedProjectIds((current) =>
      current.includes(projectId)
        ? current.filter((id) => id !== projectId)
        : [...current, projectId],
    )
  }, [])

  const handleOpenFolder = useCallback(() => {
    setProjectPickerOpen(false)
    openFolderMutation.mutate()
  }, [openFolderMutation])

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      const [defaultProject, ...additionalProjects] = selectedProjects
      if (!defaultProject || !workspaceName.trim() || isCreating) return

      setIsCreating(true)
      try {
        const workspace = await createWorkspaceMutation.mutateAsync({
          name: workspaceName.trim(),
          workDir: defaultProject.path,
          projectId: defaultProject.id,
          collaborationMode,
        })

        const failedProjects: string[] = []
        for (const project of additionalProjects) {
          try {
            await registerProjectMutation.mutateAsync({
              id: workspace.id,
              projectId: project.id,
            })
          } catch {
            failedProjects.push(project.name)
          }
        }

        void utils.ergatai.listManagedWorkspaces.invalidate()
        void utils.projects.list.invalidate()

        if (failedProjects.length > 0) {
          toast.error(i18n.t("Some projects could not be added"), {
            description: failedProjects.join(", "),
          })
        } else {
          toast.success(i18n.t("Workspace created successfully"))
        }

        goToWorkspace(workspace.id)
      } catch {
        // createWorkspaceMutation.onError already surfaces the failure.
      } finally {
        setIsCreating(false)
      }
    },
    [
      collaborationMode,
      createWorkspaceMutation,
      goToWorkspace,
      isCreating,
      registerProjectMutation,
      selectedProjects,
      utils.ergatai.listManagedWorkspaces,
      utils.projects.list,
      workspaceName,
    ],
  )

  const canSubmit =
    selectedProjects.length > 0 &&
    workspaceName.trim().length > 0 &&
    !isCreating

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open && !isCreating) close()
      }}
    >
      <DialogContent
        showCloseButton={!isCreating}
        aria-describedby={undefined}
        className="w-[560px] max-w-[calc(100vw-2rem)] gap-0 overflow-hidden rounded-2xl border-border/70 bg-background p-0 shadow-2xl"
      >
        <form onSubmit={handleSubmit}>
          <DialogTitle asChild>
            <h1 className="px-6 pb-4 pt-5 pr-12 text-lg font-semibold tracking-tight text-foreground">
              {i18n.t("New Workspace")}
            </h1>
          </DialogTitle>

          <div className="space-y-4 px-6 pb-2">
            <div className="flex h-10 items-center rounded-lg border border-input bg-background transition-shadow focus-within:border-primary focus-within:ring-[3px] focus-within:ring-primary/20">
              <span className="flex h-full items-center border-r border-input px-3 text-muted-foreground">
                <Folder className="h-4 w-4" />
              </span>
              <Input
                autoFocus
                value={workspaceName}
                onChange={(event) => setWorkspaceName(event.target.value)}
                placeholder={i18n.t("Workspace name")}
                aria-label={i18n.t("Workspace name")}
                className="h-full rounded-none border-0 bg-transparent px-3 shadow-none focus-visible:border-0 focus-visible:ring-0"
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-medium text-foreground">
                  {i18n.t("Projects")}
                </span>
                {selectedProjects.length > 0 && (
                  <span className="text-xs text-muted-foreground">
                    {selectedProjects.length}
                  </span>
                )}
              </div>

              <Popover
                open={projectPickerOpen}
                onOpenChange={(open) => {
                  setProjectPickerOpen(open)
                  if (!open) setSearchQuery("")
                }}
              >
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className={cn(
                      "flex min-h-[112px] w-full flex-col items-center justify-center gap-2 rounded-xl border border-border/70 bg-background px-4 text-center transition-colors",
                      "hover:bg-foreground/[0.02] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring/70",
                    )}
                  >
                    <FolderPlusIcon className="h-5 w-5 text-muted-foreground" />
                    <span className="text-sm font-medium text-foreground">
                      {i18n.t("Select project")}
                    </span>
                  </button>
                </PopoverTrigger>

                <PopoverContent
                  className="p-0"
                  align="start"
                  sideOffset={6}
                  style={{ width: "var(--radix-popover-trigger-width)" }}
                >
                  <Command shouldFilter={false}>
                    <CommandInput
                      placeholder={i18n.t("Filter projects")}
                      value={searchQuery}
                      onValueChange={setSearchQuery}
                    />
                    <CommandList className="max-h-[260px] overflow-y-auto">
                      {projectsQuery.isLoading ? (
                        <div className="flex items-center justify-center py-6">
                          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                        </div>
                      ) : filteredProjects.length === 0 ? (
                        <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                          {i18n.t("No projects")}
                        </div>
                      ) : (
                        <CommandGroup>
                          {filteredProjects.map((project) => {
                            const isSelected = selectedProjectIds.includes(
                              project.id,
                            )
                            return (
                              <CommandItem
                                key={project.id}
                                value={`${project.name} ${project.path}`}
                                onSelect={() => handleToggleProject(project.id)}
                                className="gap-2.5"
                              >
                                <span
                                  className={cn(
                                    "flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors",
                                    isSelected
                                      ? "border-primary bg-primary text-primary-foreground"
                                      : "border-input bg-background",
                                  )}
                                >
                                  {isSelected && <Check className="h-3 w-3" />}
                                </span>
                                <ProjectIcon
                                  project={project}
                                  className="h-4 w-4"
                                />
                                <span className="flex min-w-0 flex-1 flex-col">
                                  <span className="truncate text-sm text-foreground">
                                    {projectDisplayNames.get(project.id) ??
                                      project.name}
                                  </span>
                                  <span
                                    className="truncate font-mono text-[10px] text-muted-foreground"
                                    title={project.path}
                                  >
                                    {project.path}
                                  </span>
                                </span>
                              </CommandItem>
                            )
                          })}
                        </CommandGroup>
                      )}
                    </CommandList>
                  </Command>

                  <div className="border-t border-border/50 p-1">
                    <button
                      type="button"
                      disabled={openFolderMutation.isPending || isCreating}
                      onClick={handleOpenFolder}
                      className="flex min-h-[32px] w-full items-center gap-2 rounded-md px-2 text-sm text-foreground transition-colors hover:bg-foreground/[0.05] disabled:pointer-events-none disabled:opacity-50"
                    >
                      {openFolderMutation.isPending ? (
                        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                      ) : (
                        <FolderPlusIcon className="h-4 w-4 text-muted-foreground" />
                      )}
                      <span>{i18n.t("Open local folder")}</span>
                    </button>
                  </div>
                </PopoverContent>
              </Popover>

              {selectedProjects.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {selectedProjects.map((project, index) => (
                    <span
                      key={project.id}
                      className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border/60 bg-muted/20 py-1 pl-1.5 pr-1 text-xs"
                    >
                      <ProjectIcon project={project} className="h-3.5 w-3.5" />
                      <span className="max-w-[220px] truncate">
                        {projectDisplayNames.get(project.id) ?? project.name}
                      </span>
                      {index === 0 && (
                        <span className="shrink-0 text-[10px] text-muted-foreground">
                          {i18n.t("Default")}
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={() => handleToggleProject(project.id)}
                        aria-label={i18n.t("Remove")}
                        className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}

              <p className="text-xs leading-5 text-muted-foreground">
                {i18n.t(
                  "The first selected project becomes the workspace default project",
                )}
              </p>
            </div>
          </div>

          <div className="flex items-center justify-end gap-1 px-6 py-4">
            <Button
              type="button"
              variant="ghost"
              disabled={isCreating}
              onClick={close}
            >
              {i18n.t("Cancel")}
            </Button>
            <Button
              type="submit"
              disabled={!canSubmit}
              className="h-8 rounded-lg px-4"
            >
              {isCreating ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {i18n.t("Creating")}...
                </>
              ) : (
                i18n.t("Create workspace")
              )}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
