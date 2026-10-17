import { Provider as JotaiProvider, useAtomValue, useSetAtom } from "jotai"
import { ThemeProvider, useTheme } from "next-themes"
import { useEffect, useMemo, useState } from "react"
import { Toaster } from "sonner"
import { TooltipProvider } from "./components/ui/tooltip"
import { TRPCProvider } from "./contexts/TRPCProvider"
import { WindowProvider, getInitialWindowParams } from "./contexts/WindowContext"
import { selectedProjectAtom, selectedAgentChatIdAtom } from "./features/agents/atoms"
import type { SelectedProject } from "./features/agents/atoms"
import { useAgentConversationStore } from "./features/agents/stores/conversation-store"
import { AgentsLayout } from "./features/layout/agents-layout"
import {
  ApiKeyOnboardingPage,
  BillingMethodPage,
  SelectRepoPage,
} from "./features/onboarding"
import { identify, initAnalytics, shutdown } from "./lib/analytics"
import {
  apiKeyOnboardingCompletedAtom,
  billingMethodAtom,
} from "./lib/atoms"
import { appStore } from "./lib/jotai-store"
import { VSCodeThemeProvider } from "./lib/themes/theme-provider"
import { trpc } from "./lib/trpc"

function ThemedToaster() {
  const { resolvedTheme } = useTheme()

  return (
    <Toaster
      position="bottom-right"
      theme={resolvedTheme as "light" | "dark" | "system"}
      closeButton
    />
  )
}

function AppContent() {
  const billingMethod = useAtomValue(billingMethodAtom)
  const setBillingMethod = useSetAtom(billingMethodAtom)
  const apiKeyOnboardingCompleted = useAtomValue(apiKeyOnboardingCompletedAtom)
  const setApiKeyOnboardingCompleted = useSetAtom(apiKeyOnboardingCompletedAtom)
  const selectedProject = useAtomValue(selectedProjectAtom)
  const setSelectedProject = useSetAtom(selectedProjectAtom)
  const setSelectedChatId = useSetAtom(selectedAgentChatIdAtom)
  const { setActiveConversation, addToOpenConversations, setChatId } = useAgentConversationStore()

  useEffect(() => {
    const params = getInitialWindowParams()
    if (params.chatId) {
      console.log("[App] Opening chat from window params:", params.chatId, params.conversationId)
      setSelectedChatId(params.chatId)
      setChatId(params.chatId)
      if (params.conversationId) {
        addToOpenConversations(params.conversationId)
        setActiveConversation(params.conversationId)
      }
    }
  }, [setSelectedChatId, setChatId, addToOpenConversations, setActiveConversation])

  useEffect(() => {
    if (!window.desktopApi?.claimChat) return
    const currentChatId = appStore.get(selectedAgentChatIdAtom)
    if (!currentChatId) return
    window.desktopApi.claimChat(currentChatId).then((result) => {
      if (!result.ok) {
        setSelectedChatId(null)
      }
    })
  }, [])

  const { data: projects, isLoading: isLoadingProjects } =
    trpc.projects.list.useQuery(undefined, { staleTime: Infinity })

  const validatedProject = useMemo(() => {
    if (!selectedProject) return null
    if (isLoadingProjects) return selectedProject
    if (!projects) return null
    const exists = projects.some((p) => p.id === selectedProject.id)
    return exists ? selectedProject : null
  }, [selectedProject, projects, isLoadingProjects])

  const createProjectMutation = trpc.projects.create.useMutation({
    onSuccess: (data) => {
      console.log("[App] Auto-created default project:", data.id)
    },
  })
  const [isAutoCreatingProject, setIsAutoCreatingProject] = useState(false)

  useEffect(() => {
    if (!validatedProject && !isLoadingProjects && !isAutoCreatingProject) {
      setIsAutoCreatingProject(true)

      // Renderer code cannot access Node globals; ask main for the default path.
      const createDefaultProject = async () => {
        let defaultPath = '~/.ergatai'
        try {
          if (window.desktopApi?.getDefaultWorkspacePath) {
            defaultPath = await window.desktopApi.getDefaultWorkspacePath()
          }
        } catch (e) {
          console.warn("[App] Failed to get default workspace path:", e)
        }

        createProjectMutation.mutate(
          { path: defaultPath, name: "Default Workspace" },
          {
            onSuccess: (project) => {
              setSelectedProject({
                id: project.id,
                name: project.name,
                path: project.path,
                gitRemoteUrl: project.gitRemoteUrl,
                gitProvider: project.gitProvider as NonNullable<SelectedProject>["gitProvider"],
                gitOwner: project.gitOwner,
                gitRepo: project.gitRepo,
              })
              setIsAutoCreatingProject(false)
            },
            onError: () => {
              setIsAutoCreatingProject(false)
            },
          }
        )
      }

      createDefaultProject()
    }
  }, [validatedProject, isLoadingProjects, isAutoCreatingProject])

  return <AgentsLayout />
}

export function App() {
  useEffect(() => {
    initAnalytics()

    const syncOptOutStatus = async () => {
      try {
        const optOut =
          localStorage.getItem("preferences:analytics-opt-out") === "true"
        await window.desktopApi?.setAnalyticsOptOut(optOut)
      } catch (error) {
        console.warn("[Analytics] Failed to sync opt-out status:", error)
      }
    }

    const identifyUser = async () => {
      try {
        const user = await window.desktopApi?.getUser()
        if (user?.id) {
          identify(user.id, { email: user.email, name: user.name })
        }
      } catch (error) {
        console.warn("[Analytics] Failed to identify user:", error)
      }
    }

    void syncOptOutStatus()
    void identifyUser()

    return () => {
      shutdown()
    }
  }, [])

  return (
    <WindowProvider>
      <JotaiProvider store={appStore}>
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          <VSCodeThemeProvider>
            <TooltipProvider delayDuration={100}>
              <TRPCProvider>
                <div
                  data-agents-page
                  className="h-screen w-screen bg-background text-foreground overflow-hidden"
                >
                  <AppContent />
                </div>
                <ThemedToaster />
              </TRPCProvider>
            </TooltipProvider>
          </VSCodeThemeProvider>
        </ThemeProvider>
      </JotaiProvider>
    </WindowProvider>
  )
}
