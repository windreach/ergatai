// Modified from 1Code (Apache-2.0) by Ergatai — see MODIFICATIONS.md
import i18n from "@/lib/i18n"
import { useState, useEffect } from "react"
import { useAtom } from "jotai"
import { Button } from "../../ui/button"
import { Switch } from "../../ui/switch"
import { trpc } from "../../../lib/trpc"
import { toast } from "sonner"
import { Copy, FolderOpen, RefreshCw, Terminal, Check, Scan, WifiOff, FileJson } from "lucide-react"
import { showMessageJsonAtom } from "../../../features/agents"
import { isMockChatEnabled, setMockChatEnabled } from "../../../features/agents/lib/mock-chat-transport"

// Hook to detect narrow screen
function useIsNarrowScreen(): boolean {
  const [isNarrow, setIsNarrow] = useState(false)

  useEffect(() => {
    const checkWidth = () => {
      setIsNarrow(window.innerWidth <= 768)
    }

    checkWidth()
    window.addEventListener("resize", checkWidth)
    return () => window.removeEventListener("resize", checkWidth)
  }, [])

  return isNarrow
}

// React Scan state management (only available in dev mode)
const REACT_SCAN_SCRIPT_ID = "react-scan-script"
const REACT_SCAN_STORAGE_KEY = "react-scan-enabled"

function loadReactScan(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.getElementById(REACT_SCAN_SCRIPT_ID)) {
      resolve()
      return
    }

    const script = document.createElement("script")
    script.id = REACT_SCAN_SCRIPT_ID
    script.src = "https://unpkg.com/react-scan/dist/auto.global.js"
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error("Failed to load React Scan"))
    document.head.appendChild(script)
  })
}

function unloadReactScan(): void {
  const script = document.getElementById(REACT_SCAN_SCRIPT_ID)
  if (script) {
    script.remove()
  }
  // React Scan adds a toolbar element, try to remove it
  const toolbar = document.querySelector("[data-react-scan]")
  if (toolbar) {
    toolbar.remove()
  }
}

// react-doctor-disable-next-line no-giant-component
export function AgentsDebugTab() {
  const [copiedPath, setCopiedPath] = useState(false)
  const [copiedInfo, setCopiedInfo] = useState(false)
  const [reactScanEnabled, setReactScanEnabled] = useState(false)
  const [mockChatEnabled, setMockChatEnabledState] = useState(false)
  const [reactScanLoading, setReactScanLoading] = useState(false)
  const [showMessageJson, setShowMessageJson] = useAtom(showMessageJsonAtom)
  const isNarrowScreen = useIsNarrowScreen()

  // Check if we're in dev mode (only show React Scan in dev)
  const isDev = import.meta.env.DEV

  // Fetch system info
  const { data: systemInfo, isLoading: isLoadingSystem } =
    trpc.debug.getSystemInfo.useQuery()

  // Offline simulation state
  const { data: offlineSimulation, refetch: refetchOfflineSimulation } =
    trpc.debug.getOfflineSimulation.useQuery()
  const setOfflineSimulationMutation = trpc.debug.setOfflineSimulation.useMutation({
    onSuccess: (data) => {
      refetchOfflineSimulation()
      toast.success(
        data.enabled
          ? i18n.t("settings.debug.offlineEnabled")
          : i18n.t("settings.debug.offlineDisabled"),
        {
          description: data.enabled
            ? i18n.t("settings.debug.offlineEnabledDescription")
            : i18n.t("settings.debug.offlineDisabledDescription"),
        },
      )
    },
    onError: (error) => toast.error(error.message),
  })


  // Fetch DB stats
  const { data: dbStats, isLoading: isLoadingDb, refetch: refetchDb } =
    trpc.debug.getDbStats.useQuery()

  // Mutations
  const clearChatsMutation = trpc.debug.clearChats.useMutation({
    onSuccess: () => {
      toast.success(i18n.t("settings.debug.allChatsCleared"))
      refetchDb()
    },
    onError: (error) => toast.error(error.message),
  })

  const clearAllDataMutation = trpc.debug.clearAllData.useMutation({
    onSuccess: () => {
      toast.success(i18n.t("settings.debug.allDataCleared"))
      setTimeout(() => window.location.reload(), 500)
    },
    onError: (error) => toast.error(error.message),
  })

  const logoutMutation = trpc.debug.logout.useMutation({
    onSuccess: () => {
      toast.success(i18n.t("settings.debug.loggedOut"))
      setTimeout(() => window.location.reload(), 500)
    },
    onError: (error) => toast.error(error.message),
  })

  const openFolderMutation = trpc.debug.openUserDataFolder.useMutation({
    onError: (error) => toast.error(error.message),
  })

  const handleCopyPath = async () => {
    if (systemInfo?.userDataPath) {
      await navigator.clipboard.writeText(systemInfo.userDataPath)
      setCopiedPath(true)
      setTimeout(() => setCopiedPath(false), 2000)
    }
  }

  const handleCopyDebugInfo = async () => {
    const info = {
      ...systemInfo,
      dbStats,
      timestamp: new Date().toISOString(),
    }
    await navigator.clipboard.writeText(JSON.stringify(info, null, 2))
    setCopiedInfo(true)
    toast.success(i18n.t("settings.debug.debugInfoCopied"))
    setTimeout(() => setCopiedInfo(false), 2000)
  }

  const handleOpenDevTools = () => {
    window.desktopApi?.toggleDevTools()
  }

  const handleReactScanToggle = async (enabled: boolean) => {
    if (!isDev) return

    setReactScanLoading(true)
    try {
      if (enabled) {
        await loadReactScan()
        localStorage.setItem(REACT_SCAN_STORAGE_KEY, "true")
        setReactScanEnabled(true)
        toast.success(i18n.t("settings.debug.reactScanEnabled"), {
          description: i18n.t("settings.debug.reactScanEnabledDescription"),
        })
      } else {
        unloadReactScan()
        localStorage.removeItem(REACT_SCAN_STORAGE_KEY)
        setReactScanEnabled(false)
        toast.success(i18n.t("settings.debug.reactScanDisabled"), {
          description: i18n.t("settings.debug.reactScanDisabledDescription"),
        })
      }
    } catch (error) {
      toast.error(i18n.t("settings.debug.reactScanFailed"))
      console.error(error)
    } finally {
      setReactScanLoading(false)
    }
  }

  // Initialize React Scan state from localStorage (dev only)
  useEffect(() => {
    if (isDev && localStorage.getItem(REACT_SCAN_STORAGE_KEY) === "true") {
      loadReactScan()
        .then(() => setReactScanEnabled(true))
        .catch(console.error)
    }
  }, [isDev])

  // react-doctor-disable-next-line rendering-hydration-no-flicker
  useEffect(() => {
    setMockChatEnabledState(isMockChatEnabled())
  }, [])

  const isLoading = isLoadingSystem || isLoadingDb

  return (
    <div className="p-6 space-y-6">
      {/* Header - hidden on narrow screens since it's in the navigation bar */}
      {!isNarrowScreen && (
        <div>
          <h3 className="text-lg font-semibold mb-1">{i18n.t('Debug')}</h3>
          <p className="text-sm text-muted-foreground">
            {i18n.t("settings.debug.subtitle")}
          </p>
        </div>
      )}

      {/* System Info */}
      <div className="space-y-3">
        <h4 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
          {i18n.t("settings.debug.systemInfo")}
        </h4>
        <div className="rounded-lg border bg-muted/30 divide-y">
          <InfoRow label={i18n.t("settings.debug.version")} value={systemInfo?.version} isLoading={isLoading} />
          <InfoRow
            label={i18n.t("settings.debug.platform")}
            value={systemInfo ? i18n.t("{{platform}} ({{arch}})", { platform: systemInfo.platform, arch: systemInfo.arch }) : undefined}
            isLoading={isLoading}
          />
          <InfoRow
            label={i18n.t("settings.debug.devMode")}
            value={systemInfo?.isDev ? i18n.t("settings.debug.yes") : i18n.t("settings.debug.no")}
            isLoading={isLoading}
          />
          <InfoRow
            label={i18n.t("settings.debug.protocol")}
            value={
              systemInfo?.protocolRegistered
                ? i18n.t("settings.debug.registered")
                : i18n.t("settings.debug.notRegistered")
            }
            isLoading={isLoading}
            status={systemInfo?.protocolRegistered ? "success" : "warning"}
          />
          <div className="flex items-center justify-between p-3">
            <span className="text-sm text-muted-foreground">{i18n.t('userData')}</span>
            <div className="flex items-center gap-2">
              <span className="text-sm font-mono truncate max-w-[200px]">
                {isLoading ? "..." : systemInfo?.userDataPath}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={handleCopyPath}
                disabled={!systemInfo?.userDataPath}
              >
                {copiedPath ? (
                  <Check className="h-3 w-3 text-green-500" />
                ) : (
                  <Copy className="h-3 w-3" />
                )}
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* DB Stats */}
      <div className="space-y-3">
        <h4 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
          {i18n.t("settings.debug.database")}
        </h4>
        <div className="rounded-lg border bg-muted/30 divide-y">
          <InfoRow label={i18n.t("settings.debug.projects")} value={dbStats?.projects?.toString()} isLoading={isLoading} />
          <InfoRow label={i18n.t("settings.debug.chats")} value={dbStats?.chats?.toString()} isLoading={isLoading} />
          <InfoRow label={i18n.t("settings.debug.conversations")} value={dbStats?.conversations?.toString()} isLoading={isLoading} />
        </div>
      </div>

      {/* Developer Tools (dev mode only) */}
      {isDev && (
        <div className="space-y-3">
          <h4 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
            {i18n.t("settings.debug.developerTools")}
          </h4>
          <div className="rounded-lg border bg-muted/30 divide-y">
            <div className="flex items-center justify-between p-3">
              <div className="flex items-center gap-2">
                <Scan className="h-4 w-4 text-muted-foreground" />
                <div>
                  <span className="text-sm">{i18n.t('React Scan')}</span>
                  <p className="text-xs text-muted-foreground">
                    {i18n.t("settings.debug.highlightRerenders")}
                  </p>
                </div>
              </div>
              <Switch
                checked={reactScanEnabled}
                onCheckedChange={handleReactScanToggle}
                disabled={reactScanLoading}
              />
            </div>
            <div className="flex items-center justify-between p-3">
              <div className="flex items-center gap-2">
                <Terminal className="h-4 w-4 text-muted-foreground" />
                <div>
                  <span className="text-sm">{i18n.t('Mock Chat Replies')}</span>
                  <p className="text-xs text-muted-foreground">
                    {i18n.t("settings.debug.mockChatDescription")}
                  </p>
                </div>
              </div>
              <Switch
                checked={mockChatEnabled}
                onCheckedChange={(enabled) => {
                  setMockChatEnabled(enabled)
                  setMockChatEnabledState(enabled)
                  toast.success(
                    enabled
                      ? i18n.t("settings.debug.mockEnabled")
                      : i18n.t("settings.debug.mockDisabled"),
                    {
                      description: i18n.t("settings.debug.reloadToApply"),
                    },
                  )
                }}
              />
            </div>
            <div className="flex items-center justify-between p-3">
              <div className="flex items-center gap-2">
                <WifiOff className="h-4 w-4 text-muted-foreground" />
                <div>
                  <span className="text-sm">{i18n.t('Simulate Offline')}</span>
                  <p className="text-xs text-muted-foreground">
                    {i18n.t("settings.debug.offlineDescription")}
                  </p>
                </div>
              </div>
              <Switch
                checked={offlineSimulation?.enabled ?? false}
                onCheckedChange={(enabled) =>
                  setOfflineSimulationMutation.mutate({ enabled })
                }
                disabled={setOfflineSimulationMutation.isPending}
              />
            </div>
            <div className="flex items-center justify-between p-3">
              <div className="flex items-center gap-2">
                <FileJson className="h-4 w-4 text-muted-foreground" />
                <div>
                  <span className="text-sm">{i18n.t('Show Message JSON')}</span>
                  <p className="text-xs text-muted-foreground">
                    {i18n.t("settings.debug.messageJsonDescription")}
                  </p>
                </div>
              </div>
              <Switch
                checked={showMessageJson}
                onCheckedChange={setShowMessageJson}
              />
            </div>
          </div>
        </div>
      )}

      {/* Quick Actions */}
      <div className="space-y-3">
        <h4 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
          {i18n.t("settings.debug.quickActions")}
        </h4>
        <div className="grid grid-cols-2 gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => openFolderMutation.mutate()}
            disabled={openFolderMutation.isPending}
          >
            <FolderOpen className="h-4 w-4 mr-2" />
            {i18n.t("settings.debug.openUserData")}
          </Button>
          <Button variant="outline" size="sm" onClick={handleOpenDevTools}>
            <Terminal className="h-4 w-4 mr-2" />
            {i18n.t("settings.debug.devtools")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => window.location.reload()}
          >
            <RefreshCw className="h-4 w-4 mr-2" />
            {i18n.t("settings.debug.reload")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleCopyDebugInfo}
            disabled={isLoading}
          >
            {copiedInfo ? (
              <Check className="h-4 w-4 mr-2 text-green-500" />
            ) : (
              <Copy className="h-4 w-4 mr-2" />
            )}
            {i18n.t("settings.debug.copyInfo")}
          </Button>
        </div>
      </div>

      {/* Toast Testing */}
      <div className="space-y-3">
        <h4 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
          {i18n.t("settings.debug.toastTesting")}
        </h4>
        <div className="grid grid-cols-2 gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              toast.info(i18n.t("settings.debug.cancelationSent"), {
                description: i18n.t("settings.debug.sentToJohnSmith"),
                action: {
                  label: i18n.t("settings.debug.undo"),
                  onClick: () => toast(i18n.t("settings.debug.undone")),
                },
              })
            }
          >
            {i18n.t("settings.debug.infoUndo")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              toast.success(i18n.t("settings.debug.successToast"), {
                description: i18n.t("settings.debug.operationCompleted"),
              })
            }
          >
            {i18n.t("settings.debug.success")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              toast.error(i18n.t("settings.debug.error"), {
                description: i18n.t("settings.debug.somethingWentWrong"),
              })
            }
          >
            {i18n.t("settings.debug.error")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              toast(i18n.t("settings.debug.defaultToast"), {
                description: i18n.t("settings.debug.defaultToastDescription"),
              })
            }
          >
            {i18n.t("settings.debug.default")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              const id = toast.loading(i18n.t("settings.debug.loadingEllipsis"), {
                description: i18n.t("settings.debug.pleaseWait"),
              })
              setTimeout(() => toast.dismiss(id), 3000)
            }}
          >
            {i18n.t("settings.debug.loading")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              const id = toast.loading(i18n.t("settings.debug.processing"))
              setTimeout(() => {
                toast.success(i18n.t("settings.debug.done"), { id })
              }, 2000)
            }}
          >
            {i18n.t("settings.debug.promise")}
          </Button>
        </div>
      </div>

      {/* Data Management */}
      <div className="space-y-3">
        <h4 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
          {i18n.t("settings.debug.dataManagement")}
        </h4>
        <div className="grid grid-cols-3 gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              if (confirm(i18n.t("settings.debug.confirmClearChats"))) {
                clearChatsMutation.mutate()
              }
            }}
            disabled={clearChatsMutation.isPending}
          >
            {clearChatsMutation.isPending
              ? "..."
              : i18n.t("settings.debug.clearChats")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              if (confirm(i18n.t("settings.debug.confirmLogout"))) {
                logoutMutation.mutate()
              }
            }}
            disabled={logoutMutation.isPending}
          >
            {logoutMutation.isPending
              ? "..."
              : i18n.t("settings.debug.logout")}
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => {
              if (
                confirm(i18n.t("settings.debug.confirmReset"))
              ) {
                clearAllDataMutation.mutate()
              }
            }}
            disabled={clearAllDataMutation.isPending}
          >
            {clearAllDataMutation.isPending
              ? "..."
              : i18n.t("settings.debug.resetAll")}
          </Button>
        </div>
      </div>
    </div>
  )
}

// Helper component for info rows
function InfoRow({
  label,
  value,
  isLoading,
  status,
}: {
  label: string
  value?: string
  isLoading?: boolean
  status?: "success" | "warning" | "error"
}) {
  return (
    <div className="flex items-center justify-between p-3">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span
        className={`text-sm font-medium ${
          status === "success"
            ? "text-green-500"
            : status === "warning"
              ? "text-yellow-500"
              : status === "error"
                ? "text-red-500"
                : ""
        }`}
      >
        {isLoading ? "..." : value ?? "-"}
      </span>
    </div>
  )
}