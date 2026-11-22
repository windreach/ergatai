// Modified from 1Code (Apache-2.0) by Ergatai — see MODIFICATIONS.md
import i18n from "@/lib/i18n"
import { resolveLanguage } from "@/lib/language"
import { useAtom } from "jotai"
import { useTranslation } from "react-i18next"
import { useEffect, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  analyticsOptOutAtom,
  autoAdvanceTargetAtom,
  ctrlTabTargetAtom,
  desktopNotificationsEnabledAtom,
  extendedThinkingEnabledAtom,
  notifyWhenFocusedAtom,
  soundNotificationsEnabledAtom,
  preferredEditorAtom,
  languagePreferenceAtom,
  type AutoAdvanceTarget,
  type CtrlTabTarget,
} from "../../../lib/atoms"
import { APP_META, type ExternalApp } from "../../../../shared/external-apps"

// Editor icon imports
import cursorIcon from "../../../assets/app-icons/cursor.svg"
import vscodeIcon from "../../../assets/app-icons/vscode.svg"
import vscodeInsidersIcon from "../../../assets/app-icons/vscode-insiders.svg"
import zedIcon from "../../../assets/app-icons/zed.png"
import sublimeIcon from "../../../assets/app-icons/sublime.svg"
import xcodeIcon from "../../../assets/app-icons/xcode.svg"
import intellijIcon from "../../../assets/app-icons/intellij.svg"
import webstormIcon from "../../../assets/app-icons/webstorm.svg"
import pycharmIcon from "../../../assets/app-icons/pycharm.svg"
import phpstormIcon from "../../../assets/app-icons/phpstorm.svg"
import golandIcon from "../../../assets/app-icons/goland.svg"
import clionIcon from "../../../assets/app-icons/clion.svg"
import riderIcon from "../../../assets/app-icons/rider.svg"
import fleetIcon from "../../../assets/app-icons/fleet.svg"
import rustroverIcon from "../../../assets/app-icons/rustrover.svg"
import windsurfIcon from "../../../assets/app-icons/windsurf.svg"
import traeIcon from "../../../assets/app-icons/trae.svg"
import itermIcon from "../../../assets/app-icons/iterm.png"
import warpIcon from "../../../assets/app-icons/warp.png"
import terminalIcon from "../../../assets/app-icons/terminal.png"
import ghosttyIcon from "../../../assets/app-icons/ghostty.svg"

const EDITOR_ICONS: Partial<Record<ExternalApp, string>> = {
  cursor: cursorIcon,
  vscode: vscodeIcon,
  "vscode-insiders": vscodeInsidersIcon,
  zed: zedIcon,
  windsurf: windsurfIcon,
  sublime: sublimeIcon,
  xcode: xcodeIcon,
  trae: traeIcon,
  iterm: itermIcon,
  warp: warpIcon,
  terminal: terminalIcon,
  ghostty: ghosttyIcon,
  intellij: intellijIcon,
  webstorm: webstormIcon,
  pycharm: pycharmIcon,
  phpstorm: phpstormIcon,
  goland: golandIcon,
  clion: clionIcon,
  rider: riderIcon,
  fleet: fleetIcon,
  rustrover: rustroverIcon,
}

interface EditorOption {
  id: ExternalApp
  label: string
}

// Default mode uses the existing permission system (ask / auto / auto_bash / full_access).
type PermissionMode = "ask" | "auto" | "auto_bash" | "full_access"

const PERMISSION_MODE_OPTIONS: Array<{
  id: PermissionMode
  labelKey: string
  danger?: boolean
}> = [
  { id: "ask", labelKey: "settings.preferences.permissionModeAsk" },
  { id: "auto", labelKey: "settings.preferences.permissionModeAuto" },
  { id: "auto_bash", labelKey: "settings.preferences.permissionModeAutoBash" },
  {
    id: "full_access",
    labelKey: "settings.preferences.permissionModeFullAccess",
    danger: true,
  },
]

// Order matches Superset: editors, terminals, VS Code, JetBrains
const EDITORS: EditorOption[] = [
  { id: "cursor", label: "Cursor" },
  { id: "zed", label: "Zed" },
  { id: "sublime", label: "Sublime Text" },
  { id: "xcode", label: "Xcode" },
  { id: "windsurf", label: "Windsurf" },
  { id: "trae", label: "Trae" },
]

const TERMINALS: EditorOption[] = [
  { id: "iterm", label: "iTerm" },
  { id: "warp", label: "Warp" },
  { id: "terminal", label: "Terminal" },
  { id: "ghostty", label: "Ghostty" },
]

const VSCODE: EditorOption[] = [
  { id: "vscode", label: "VS Code" },
  { id: "vscode-insiders", label: "VS Code Insiders" },
]

const JETBRAINS: EditorOption[] = [
  { id: "intellij", label: "IntelliJ IDEA" },
  { id: "webstorm", label: "WebStorm" },
  { id: "pycharm", label: "PyCharm" },
  { id: "phpstorm", label: "PhpStorm" },
  { id: "goland", label: "GoLand" },
  { id: "clion", label: "CLion" },
  { id: "rider", label: "Rider" },
  { id: "fleet", label: "Fleet" },
  { id: "rustrover", label: "RustRover" },
]
import vscodeBaseIcon from "../../../assets/app-icons/vscode.svg"
import jetbrainsBaseIcon from "../../../assets/app-icons/jetbrains.svg"
import { Kbd } from "../../ui/kbd"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "../../ui/select"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu"
import { ChevronDown } from "lucide-react"
import { Switch } from "../../ui/switch"
import { Button } from "../../ui/button"
import {
  AlertDialog,
  AlertDialogBody,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../ui/alert-dialog"
import { trpc } from "../../../lib/trpc"

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

// react-doctor-disable-next-line no-giant-component
export function AgentsPreferencesTab() {
  const [thinkingEnabled, setThinkingEnabled] = useAtom(
    extendedThinkingEnabledAtom,
  )
  const [soundEnabled, setSoundEnabled] = useAtom(soundNotificationsEnabledAtom)
  const [desktopNotificationsEnabled, setDesktopNotificationsEnabled] = useAtom(desktopNotificationsEnabledAtom)
  const [notifyWhenFocused, setNotifyWhenFocused] = useAtom(notifyWhenFocusedAtom)
  const [analyticsOptOut, setAnalyticsOptOut] = useAtom(analyticsOptOutAtom)
  const [ctrlTabTarget, setCtrlTabTarget] = useAtom(ctrlTabTargetAtom)
  const [autoAdvanceTarget, setAutoAdvanceTarget] = useAtom(autoAdvanceTargetAtom)
  const [preferredEditor, setPreferredEditor] = useAtom(preferredEditorAtom)
  const [languagePreference, setLanguagePreference] = useAtom(languagePreferenceAtom)
  const isNarrowScreen = useIsNarrowScreen()
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [confirmingFullAccess, setConfirmingFullAccess] = useState(false)

  // Default permission mode, backed by the same global permission system used
  // by the in-chat permission selector (ask / auto / full_access).
  const permissionModeQuery = trpc.ergatai.getPermissionMode.useQuery(undefined, {
    retry: false,
    refetchOnWindowFocus: false,
  })
  const setPermissionModeMutation = trpc.ergatai.setPermissionMode.useMutation({
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: [["ergatai", "getPermissionMode"]],
      })
    },
  })
  const permissionModeResponse = permissionModeQuery.data as
    | { mode?: PermissionMode }
    | undefined
  const permissionMode: PermissionMode =
    permissionModeResponse?.mode === "auto" ||
    permissionModeResponse?.mode === "auto_bash" ||
    permissionModeResponse?.mode === "full_access"
      ? permissionModeResponse.mode
      : "auto"
  const permissionModeLabel =
    t(
      PERMISSION_MODE_OPTIONS.find((option) => option.id === permissionMode)
        ?.labelKey ?? "settings.preferences.permissionModeAsk",
    )

  const handlePermissionModeChange = (value: string) => {
    if (value !== "ask" && value !== "auto" && value !== "auto_bash" && value !== "full_access") return
    // Enabling Full Access requires explicit confirmation, mirroring the
    // in-chat permission selector.
    if (value === "full_access" && permissionMode !== "full_access") {
      setConfirmingFullAccess(true)
      return
    }
    setPermissionModeMutation.mutate({ mode: value })
  }

  // Sync opt-out status to main process
  const handleAnalyticsToggle = async (optedOut: boolean) => {
    setAnalyticsOptOut(optedOut)
    // Notify main process
    try {
      await window.desktopApi?.setAnalyticsOptOut(optedOut)
    } catch (error) {
      console.error("Failed to sync analytics opt-out to main process:", error)
    }
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header - hidden on narrow screens since it's in the navigation bar */}
      {!isNarrowScreen && (
        <div className="flex flex-col gap-1.5 text-center sm:text-left">
          <h3 className="text-sm font-semibold text-foreground">{t("settings.preferences.title")}</h3>
          <p className="text-xs text-muted-foreground">
            {t("settings.preferences.subtitle")}
          </p>
        </div>
      )}

      {/* Agent Behavior */}
      <div className="bg-background rounded-lg border border-border overflow-hidden">
        <div className="flex items-center justify-between p-4">
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium text-foreground">
              {t("settings.preferences.extendedThinking")}
            </span>
            <span className="text-xs text-muted-foreground">
              {t("settings.preferences.extendedThinkingDescription")}{" "}
              <span className="text-foreground/70">{t('Disables response streaming.')}</span>
            </span>
          </div>
          <Switch
            checked={thinkingEnabled}
            onCheckedChange={setThinkingEnabled}
          />
        </div>
        <div className="flex items-center justify-between p-4 border-t border-border">
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium text-foreground">
              {t("settings.preferences.defaultMode")}
            </span>
            <span className="text-xs text-muted-foreground">
              {t("settings.preferences.defaultModeDescription")}
            </span>
          </div>
          <Select
            value={permissionMode}
            disabled={permissionModeQuery.isLoading}
            onValueChange={handlePermissionModeChange}
          >
            <SelectTrigger className="w-auto px-2">
              <span
                className={
                  permissionMode === "full_access"
                    ? "text-xs text-red-500"
                    : "text-xs"
                }
              >
                {permissionModeLabel}
              </span>
            </SelectTrigger>
            <SelectContent>
              {PERMISSION_MODE_OPTIONS.map((option) => (
                <SelectItem
                  key={option.id}
                  value={option.id}
                  className={option.danger ? "text-red-500" : undefined}
                >
                  {t(option.labelKey)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <AlertDialog
          open={confirmingFullAccess}
          onOpenChange={setConfirmingFullAccess}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle className="text-red-500">
                {t("settings.preferences.enableFullAccessTitle")}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t("permissions.fullAccessWarning")}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogBody />
            <AlertDialogFooter>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setConfirmingFullAccess(false)}
              >
                {t("Cancel")}
              </Button>
              <Button
                size="sm"
                className="bg-red-500 hover:bg-red-600 text-white"
                onClick={() => {
                  setPermissionModeMutation.mutate({ mode: "full_access" })
                  setConfirmingFullAccess(false)
                }}
              >
                {t("settings.preferences.enableFullAccessConfirm")}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      {/* Notifications */}
      <div className="bg-background rounded-lg border border-border overflow-hidden">
        <div className="flex items-center justify-between p-4">
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium text-foreground">
              {t("settings.preferences.desktopNotifications")}
            </span>
            <span className="text-xs text-muted-foreground">
              {t("settings.preferences.desktopNotificationsDescription")}
            </span>
          </div>
          <Switch checked={desktopNotificationsEnabled} onCheckedChange={setDesktopNotificationsEnabled} />
        </div>
        <div className="flex items-center justify-between p-4 border-t border-border">
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium text-foreground">
              {t("settings.preferences.soundNotifications")}
            </span>
            <span className="text-xs text-muted-foreground">
              {t("settings.preferences.soundNotificationsDescription")}
            </span>
          </div>
          <Switch checked={soundEnabled} onCheckedChange={setSoundEnabled} />
        </div>
        <div className="flex items-center justify-between p-4 border-t border-border">
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium text-foreground">
              {t("settings.preferences.notifyWhenFocused")}
            </span>
            <span className="text-xs text-muted-foreground">
              {t("settings.preferences.notifyWhenFocusedDescription")}
            </span>
          </div>
          <Switch
            checked={notifyWhenFocused}
            onCheckedChange={setNotifyWhenFocused}
            disabled={!desktopNotificationsEnabled}
          />
        </div>
      </div>

      {/* Navigation */}
      <div className="bg-background rounded-lg border border-border overflow-hidden">
        <div className="flex items-center justify-between p-4">
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium text-foreground">
              {t("settings.preferences.quickSwitch")}
            </span>
            <span className="text-xs text-muted-foreground">
              {t("settings.preferences.quickSwitchDescriptionBefore")}{" "}
              <Kbd>⌃Tab</Kbd>{" "}
              {t("settings.preferences.quickSwitchDescriptionAfter")}
            </span>
          </div>
          <Select
            value={ctrlTabTarget}
            onValueChange={(value: CtrlTabTarget) => setCtrlTabTarget(value)}
          >
            <SelectTrigger className="w-auto px-2">
              <span className="text-xs">
                {ctrlTabTarget === "workspaces"
                  ? t("Workspaces")
                  : t("Agents")}
              </span>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="workspaces">{t('Workspaces')}</SelectItem>
              <SelectItem value="agents">{t('Agents')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center justify-between p-4 border-t border-border">
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium text-foreground">
              {t("settings.preferences.autoAdvance")}
            </span>
            <span className="text-xs text-muted-foreground">
              {t("settings.preferences.autoAdvanceDescription")}
            </span>
          </div>
          <Select
            value={autoAdvanceTarget}
            onValueChange={(value: AutoAdvanceTarget) => setAutoAdvanceTarget(value)}
          >
            <SelectTrigger className="w-auto px-2">
              <span className="text-xs">
                {autoAdvanceTarget === "next"
                  ? t("Go to next workspace")
                  : autoAdvanceTarget === "previous"
                    ? t("Go to previous workspace")
                    : t("Close workspace")}
              </span>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="next">{t('Go to next workspace')}</SelectItem>
              <SelectItem value="previous">{t('Go to previous workspace')}</SelectItem>
              <SelectItem value="close">{t('Close workspace')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center justify-between p-4 border-t border-border">
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium text-foreground">
              {t("settings.preferences.preferredEditor")}
            </span>
            <span className="text-xs text-muted-foreground">
              {t("settings.preferences.preferredEditorDescription")}
            </span>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-2 py-1.5 text-xs hover:bg-accent hover:text-accent-foreground transition-colors"
              >
                {EDITOR_ICONS[preferredEditor] && (
                  <img
                    src={EDITOR_ICONS[preferredEditor]}
                    alt=""
                    className="h-4 w-4 flex-shrink-0"
                  />
                )}
                <span className="truncate">
                  {APP_META[preferredEditor].label}
                </span>
                <ChevronDown className="h-3 w-3 opacity-50" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              {EDITORS.map((editor) => (
                <DropdownMenuItem
                  key={editor.id}
                  onClick={() => setPreferredEditor(editor.id)}
                  className="flex items-center gap-2"
                >
                  {EDITOR_ICONS[editor.id] ? (
                    <img src={EDITOR_ICONS[editor.id]} alt="" className="h-4 w-4 flex-shrink-0 object-contain" />
                  ) : (
                    <div className="h-4 w-4 flex-shrink-0" />
                  )}
                  <span>{editor.label}</span>
                </DropdownMenuItem>
              ))}
              {TERMINALS.map((app) => (
                <DropdownMenuItem
                  key={app.id}
                  onClick={() => setPreferredEditor(app.id)}
                  className="flex items-center gap-2"
                >
                  {EDITOR_ICONS[app.id] ? (
                    <img src={EDITOR_ICONS[app.id]} alt="" className="h-4 w-4 flex-shrink-0 object-contain" />
                  ) : (
                    <div className="h-4 w-4 flex-shrink-0" />
                  )}
                  <span>{app.label}</span>
                </DropdownMenuItem>
              ))}
              <DropdownMenuSub>
                <DropdownMenuSubTrigger className="flex items-center gap-2">
                  <img src={vscodeBaseIcon} alt="" className="h-4 w-4 flex-shrink-0 object-contain" />
                  <span>{t('VS Code')}</span>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-48" sideOffset={6} alignOffset={-4}>
                  {VSCODE.map((app) => (
                    <DropdownMenuItem
                      key={app.id}
                      onClick={() => setPreferredEditor(app.id)}
                      className="flex items-center gap-2"
                    >
                      {EDITOR_ICONS[app.id] ? (
                        <img src={EDITOR_ICONS[app.id]} alt="" className="h-4 w-4 flex-shrink-0 object-contain" />
                      ) : (
                        <div className="h-4 w-4 flex-shrink-0" />
                      )}
                      <span>{app.label}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger className="flex items-center gap-2">
                  <img src={jetbrainsBaseIcon} alt="" className="h-4 w-4 flex-shrink-0 object-contain" />
                  <span>{t('JetBrains')}</span>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-48 max-h-[300px] overflow-y-auto" sideOffset={6} alignOffset={-4}>
                  {JETBRAINS.map((app) => (
                    <DropdownMenuItem
                      key={app.id}
                      onClick={() => setPreferredEditor(app.id)}
                      className="flex items-center gap-2"
                    >
                      {EDITOR_ICONS[app.id] ? (
                        <img src={EDITOR_ICONS[app.id]} alt="" className="h-4 w-4 flex-shrink-0 object-contain" />
                      ) : (
                        <div className="h-4 w-4 flex-shrink-0" />
                      )}
                      <span>{app.label}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Language */}
      <div className="bg-background rounded-lg border border-border overflow-hidden">
        <div className="flex items-center justify-between p-4">
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium text-foreground">
              {t("settings.language")}
            </span>
            <span className="text-xs text-muted-foreground">
              {t("settings.preferences.languageDescription")}
            </span>
          </div>
          <Select
            value={languagePreference}
            onValueChange={(value: any) => { setLanguagePreference(value); void i18n.changeLanguage(resolveLanguage(value)); window.location.reload() }}
          >
            <SelectTrigger className="w-auto px-2">
              <span className="text-xs">
                {languagePreference === "system"
                  ? t("settings.system")
                  : languagePreference === "en"
                    ? t("settings.english")
                    : t("settings.chinese")}
              </span>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="system">{t("settings.system")}</SelectItem>
              <SelectItem value="en">{t("settings.english")}</SelectItem>
              <SelectItem value="zh-CN">{t("settings.chinese")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Privacy — temporarily hidden
      <div className="bg-background rounded-lg border border-border overflow-hidden">
        <div className="flex items-center justify-between gap-6 p-4">
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium text-foreground">
              Share Usage Analytics
            </span>
            <span className="text-xs text-muted-foreground">
              Help us improve Agents by sharing anonymous usage data. We only track feature usage and app performance–never your code, prompts, or messages. No AI training on your data.
            </span>
          </div>
          <Switch
            checked={!analyticsOptOut}
            onCheckedChange={(enabled) => handleAnalyticsToggle(!enabled)}
          />
        </div>
      </div>
      */}
    </div>
  )
}