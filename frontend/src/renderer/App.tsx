import { Component, type ReactNode } from "react"
import { Provider as JotaiProvider, useAtomValue, useSetAtom } from "jotai"
import { ThemeProvider, useTheme } from "next-themes"
import { useEffect } from "react"
import { Toaster } from "sonner"
import { AlertCircle, RefreshCw } from "lucide-react"
import { TooltipProvider } from "./components/ui/tooltip"
import { TRPCProvider } from "./contexts/TRPCProvider"
import { WindowProvider, getInitialWindowParams } from "./contexts/WindowContext"
import { selectedAgentChatIdAtom } from "./features/agents/atoms"
import { useAgentConversationStore } from "./features/agents/stores/conversation-store"
import { AgentsLayout } from "./features/layout/agents-layout"
import { identify, initAnalytics, shutdown } from "./lib/analytics"
import {
  apiKeyOnboardingCompletedAtom,
  billingMethodAtom,
} from "./lib/atoms"
import { appStore } from "./lib/jotai-store"
import { VSCodeThemeProvider } from "./lib/themes/theme-provider"
import { trpc } from "./lib/trpc"

interface GlobalErrorBoundaryProps {
  children: ReactNode
}

interface GlobalErrorBoundaryState {
  hasError: boolean
  error: Error | null
}

class GlobalErrorBoundary extends Component<
  GlobalErrorBoundaryProps,
  GlobalErrorBoundaryState
> {
  constructor(props: GlobalErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): GlobalErrorBoundaryState {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("🔴 [GlobalErrorBoundary] App crashed:", error, errorInfo)
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null })
    window.location.reload()
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="h-screen w-screen flex flex-col items-center justify-center bg-background select-none">
          <div className="fixed top-0 left-0 right-0 h-10" />
          <div className="w-full max-w-[440px] space-y-8 px-4">
            <div className="text-center space-y-4">
              <div className="flex items-center justify-center mx-auto w-max">
                <div className="w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center">
                  <AlertCircle className="w-6 h-6 text-destructive" />
                </div>
              </div>
              <div className="space-y-1">
                <h1 className="text-base font-semibold tracking-tight">
                  Something went wrong
                </h1>
                <p className="text-sm text-muted-foreground">
                  {this.state.error?.message || "An unexpected error occurred."}
                </p>
              </div>
            </div>
            <div className="space-y-3">
              <button
                onClick={this.handleReset}
                className="w-full h-8 px-4 bg-primary text-primary-foreground rounded-lg text-sm font-medium transition-[background-color,transform] duration-150 hover:bg-primary/90 active:scale-[0.97] flex items-center justify-center gap-2"
              >
                <RefreshCw className="h-4 w-4" />
                Reload app
              </button>
            </div>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}

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

  // 移除了自动创建默认项目的逻辑
  // 原因：这段代码会导致竞态条件和数据不一致
  // 用户应该手动选择或创建项目，而不是自动创建"默认项目"

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
    <GlobalErrorBoundary>
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
    </GlobalErrorBoundary>
  )
}
