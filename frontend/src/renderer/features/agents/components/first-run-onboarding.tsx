import i18n from "@/lib/i18n"
"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useAtom, useAtomValue, useSetAtom } from "jotai"
import {
  ArrowRight,
  Check,
  Circle,
  Loader2,
  Sparkles,
  X,
} from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { trpc } from "@/lib/trpc"
import { cn } from "@/lib/utils"
import {
  agentsConversationsSidebarModeAtom,
  agentsMobileViewModeAtom,
  desktopViewAtom,
  manageAgentsSectionAtom,
  selectedAgentChatIdAtom,
  selectedDraftIdAtom,
  selectedWorkspaceIdAtom,
  showNewChatFormAtom,
} from "../atoms"
import { useCollaborationMode } from "../collaboration/use-collaboration-mode"

const DEFAULT_WORKSPACE_NAME = "Default Workspace"
const DEFAULT_PROJECT_NAME = "Default Project"
const DEFAULT_WORK_DIR = "~/.ergatai"
const INITIALIZED_KEY = "ergatai:onboarding:default-workspace-initialized"
const DISMISSED_KEY = "ergatai:onboarding:guide-dismissed"

function readFlag(key: string): boolean {
  if (typeof window === "undefined") return false
  try {
    return window.localStorage.getItem(key) === "true"
  } catch {
    return false
  }
}

function writeFlag(key: string): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(key, "true")
  } catch {
    // Non-fatal: the current session still works without persistence.
  }
}

interface GuideStepProps {
  done: boolean
  loading?: boolean
  title: string
  detail: string
}

function GuideStep({ done, loading = false, title, detail }: GuideStepProps) {
  return (
    <div className="flex items-start gap-2.5">
      <span
        className={cn(
          "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
          done
            ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
            : "border-border bg-background text-muted-foreground/60",
        )}
      >
        {loading ? (
          <Loader2 className="h-2.5 w-2.5 animate-spin" />
        ) : done ? (
          <Check className="h-2.5 w-2.5" />
        ) : (
          <Circle className="h-2 w-2" />
        )}
      </span>
      <span className="min-w-0">
        <span className="block text-xs font-medium text-foreground">
          {title}
        </span>
        <span className="block text-[11px] leading-4 text-muted-foreground">
          {detail}
        </span>
      </span>
    </div>
  )
}

/**
 * First-run onboarding.
 *
 * Ensures the app starts in a usable state by creating/selecting a default
 * workspace, then shows a lightweight, dismissible checklist that points the
 * user at provider setup and their first task.
 */
export function FirstRunOnboarding() {
  const [desktopView, setDesktopView] = useAtom(desktopViewAtom)
  const selectedWorkspaceId = useAtomValue(selectedWorkspaceIdAtom)
  const setSelectedWorkspaceId = useSetAtom(selectedWorkspaceIdAtom)
  const setSelectedChatId = useSetAtom(selectedAgentChatIdAtom)
  const setSelectedDraftId = useSetAtom(selectedDraftIdAtom)
  const setShowNewChatForm = useSetAtom(showNewChatFormAtom)
  const setConversationsSidebarMode = useSetAtom(
    agentsConversationsSidebarModeAtom,
  )
  const setMobileViewMode = useSetAtom(agentsMobileViewModeAtom)
  const setManageAgentsSection = useSetAtom(manageAgentsSectionAtom)

  const { mode: collaborationMode } = useCollaborationMode()
  const utils = trpc.useUtils()
  const [guideVisible, setGuideVisible] = useState(false)
  const didInitializeRef = useRef(false)

  const workspacesQuery = trpc.ergatai.listManagedWorkspaces.useQuery(
    { collaborationMode },
    { staleTime: 10_000 },
  )
  const providerConnectionsQuery =
    trpc.ergatai.listProviderConnections.useQuery(undefined, {
      staleTime: 10_000,
      enabled: guideVisible,
    })
  const createWorkspaceMutation = trpc.ergatai.createWorkspace.useMutation()

  const selectWorkspace = useCallback(
    (workspaceId: string) => {
      setSelectedWorkspaceId(workspaceId)
      setConversationsSidebarMode("sidebar")
      setSelectedChatId(null)
      setSelectedDraftId(null)
      setShowNewChatForm(true)
      setMobileViewMode("chat")
    },
    [
      setConversationsSidebarMode,
      setMobileViewMode,
      setSelectedChatId,
      setSelectedDraftId,
      setSelectedWorkspaceId,
      setShowNewChatForm,
    ],
  )

  // react-doctor-disable-next-line no-set-state-after-await-in-effect
  useEffect(() => {
    if (didInitializeRef.current) return
    if (!workspacesQuery.isFetched || workspacesQuery.isError) return

    didInitializeRef.current = true
    const workspaces = workspacesQuery.data ?? []
    const alreadyInitialized = readFlag(INITIALIZED_KEY)

    const chooseExistingWorkspace = () => {
      if (selectedWorkspaceId) return
      const target =
        workspaces.find(
          (workspace) => workspace.name === DEFAULT_WORKSPACE_NAME,
        ) ?? workspaces[0]
      if (target) selectWorkspace(target.id)
    }

    // The app was already set up before. Keep the default workspace selected
    // when nothing is active; if every workspace was removed, fall back to the
    // floating creator instead of showing a blank screen.
    if (alreadyInitialized) {
      if (workspaces.length === 0) {
        // react-doctor-disable-next-line no-set-state-after-await-in-effect
        setDesktopView("new-workspace")
      } else {
        chooseExistingWorkspace()
        if (!readFlag(DISMISSED_KEY)) setGuideVisible(true)
      }
      return
    }

    if (workspaces.length > 0) {
      writeFlag(INITIALIZED_KEY)
      chooseExistingWorkspace()
      if (!readFlag(DISMISSED_KEY)) setGuideVisible(true)
      return
    }

    // First launch with an empty backend: create the starter workspace so the
    // main area can open directly on the new-chat form.
    void (async () => {
      try {
        const workspace = await createWorkspaceMutation.mutateAsync({
          name: DEFAULT_WORKSPACE_NAME,
          workDir: DEFAULT_WORK_DIR,
          projectPath: DEFAULT_WORK_DIR,
          projectName: DEFAULT_PROJECT_NAME,
          collaborationMode,
        })
        writeFlag(INITIALIZED_KEY)
        await Promise.all([
          utils.ergatai.listManagedWorkspaces.invalidate(),
          utils.projects.list.invalidate(),
        ])
        // react-doctor-disable-next-line no-set-state-after-await-in-effect
        selectWorkspace(workspace.id)
        if (!readFlag(DISMISSED_KEY)) {
          // react-doctor-disable-next-line no-set-state-after-await-in-effect
          setGuideVisible(true)
        }
      } catch (error) {
        toast.error(i18n.t("Failed to create default workspace"), {
          description:
            error instanceof Error ? error.message : i18n.t("Please try again"),
        })
        // react-doctor-disable-next-line no-set-state-after-await-in-effect
        setDesktopView("new-workspace")
      }
    })()
  }, [
    collaborationMode,
    createWorkspaceMutation,
    selectedWorkspaceId,
    selectWorkspace,
    setDesktopView,
    utils.ergatai.listManagedWorkspaces,
    utils.projects.list,
    workspacesQuery.data,
    workspacesQuery.isError,
    workspacesQuery.isFetched,
  ])

  const dismissGuide = useCallback(() => {
    writeFlag(DISMISSED_KEY)
    setGuideVisible(false)
  }, [])

  const openProviderSettings = useCallback(() => {
    setManageAgentsSection("providers")
    setDesktopView("add-agent")
  }, [setDesktopView, setManageAgentsSection])

  const startFirstTask = useCallback(() => {
    dismissGuide()
    window.setTimeout(() => {
      document.querySelector<HTMLElement>('[contenteditable="true"]')?.focus()
    }, 80)
  }, [dismissGuide])

  if (!guideVisible || desktopView) return null

  const workspaces = workspacesQuery.data ?? []
  const defaultWorkspace =
    workspaces.find(
      (workspace) => workspace.name === DEFAULT_WORKSPACE_NAME,
    ) ?? workspaces[0]
  const providerReady = (providerConnectionsQuery.data?.length ?? 0) > 0
  const providerLoading = providerConnectionsQuery.isLoading
  const primaryAction = providerReady ? startFirstTask : openProviderSettings

  return (
    <section
      aria-label={i18n.t("Getting started")}
      className="fixed bottom-4 right-4 z-40 w-[360px] max-w-[calc(100vw-2rem)] rounded-xl border border-border/70 bg-background p-4 shadow-2xl"
    >
      <button
        type="button"
        onClick={dismissGuide}
        aria-label={i18n.t("Dismiss")}
        className="absolute right-3 top-3 flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
      >
        <X className="h-3.5 w-3.5" />
      </button>

      <div className="flex items-start gap-3 pr-6">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Sparkles className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">
            {i18n.t("Welcome to Ergatai")}
          </h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {i18n.t(
              "Your default workspace is ready — finish these steps to get started",
            )}
          </p>
        </div>
      </div>

      <div className="mt-4 space-y-3">
        <GuideStep
          done
          title={i18n.t("Default workspace is ready")}
          detail={defaultWorkspace?.name || DEFAULT_WORKSPACE_NAME}
        />
        <GuideStep
          done={providerReady}
          loading={providerLoading}
          title={
            providerReady
              ? i18n.t("Agent provider connected")
              : i18n.t("Connect an agent provider")
          }
          detail={
            providerReady
              ? i18n.t("Provider connections are configured")
              : i18n.t("Add an API key or endpoint for an agent")
          }
        />
        <GuideStep
          done={false}
          title={i18n.t("Send your first task")}
          detail={i18n.t("Describe what you want the agents to do")}
        />
      </div>

      <Button
        type="button"
        onClick={primaryAction}
        className="mt-4 h-8 w-full rounded-lg px-4"
      >
        {providerReady
          ? i18n.t("Start first task")
          : i18n.t("Configure provider")}
        <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
      </Button>
    </section>
  )
}
