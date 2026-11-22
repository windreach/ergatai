// Modified from 1Code (Apache-2.0) by Ergatai — see MODIFICATIONS.md
import i18n from "@/lib/i18n"
import { useAtom, useAtomValue, useSetAtom } from "jotai"
import { ChevronLeft } from "lucide-react"
import { useCallback, useEffect, useMemo } from "react"
import {
  EyeOpenFilledIcon,
  SlidersFilledIcon,
} from "../../icons"
import {
  agentsSettingsDialogActiveTabAtom,
  devToolsUnlockedAtom,
  isDesktopAtom,
  type SettingsTab,
} from "../../lib/atoms"
import { cn } from "../../lib/utils"
import {
  BugFilledIcon,
  KeyboardFilledIcon,
} from "../../components/ui/icons"
import { desktopViewAtom } from "../agents"

// Check if we're in development mode
const isDevelopment = import.meta.env.DEV

// General settings tabs
const MAIN_TABS = [
  {
    id: "preferences" as SettingsTab,
    label: "settings.sidebar.preferences",
    icon: SlidersFilledIcon,
  },
  {
    id: "appearance" as SettingsTab,
    label: "settings.sidebar.appearance",
    icon: EyeOpenFilledIcon,
  },
  {
    id: "keyboard" as SettingsTab,
    label: "settings.sidebar.keyboard",
    icon: KeyboardFilledIcon,
  },
]

// Debug tab definition
const DEBUG_TAB = {
  id: "debug" as SettingsTab,
  label: "settings.sidebar.debug",
  icon: BugFilledIcon,
}

interface TabButtonProps {
  tab: {
    id: SettingsTab
    label: string
    icon: React.ComponentType<{ className?: string }> | unknown
  }
  isActive: boolean
  onClick: () => void
}

function TabButton({ tab, isActive, onClick }: TabButtonProps) {
  const Icon = tab.icon as React.ComponentType<{ className?: string }>
  const isProjectTab = "projectId" in tab

  return (
    <button
      type="button"
      role="tab"
      onClick={onClick}
      aria-selected={isActive}
      className={cn(
        "inline-flex items-center whitespace-nowrap transition-colors duration-75 cursor-pointer w-full justify-start gap-2 text-left px-3 py-1.5 text-sm h-7 rounded-md",
        "outline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring/70",
        isActive
          ? "bg-foreground/5 text-foreground font-medium"
          : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground font-medium"
      )}
    >
      <Icon
        className={cn(
          "h-4 w-4",
          isProjectTab ? "opacity-100" : isActive ? "opacity-100" : "opacity-50"
        )}
      />
      <span className="flex-1 truncate">{i18n.t(tab.label)}</span>
    </button>
  )
}

export function SettingsSidebar() {
  const [activeTab, setActiveTab] = useAtom(agentsSettingsDialogActiveTabAtom)
  const [devToolsUnlocked, _setDevToolsUnlocked] = useAtom(devToolsUnlockedAtom)
  const setDesktopView = useSetAtom(desktopViewAtom)
  const isDesktop = useAtomValue(isDesktopAtom)

  // Hide native traffic lights when settings sidebar is shown
  useEffect(() => {
    if (!isDesktop) return
    if (typeof window === "undefined" || !window.desktopApi?.setTrafficLightVisibility) return
    window.desktopApi.setTrafficLightVisibility(false)
  }, [isDesktop])

  // Show debug tab if in development OR if devtools are unlocked
  const showDebugTab = isDevelopment || devToolsUnlocked

  const mainTabs = useMemo(() => {
    if (showDebugTab) return [...MAIN_TABS, DEBUG_TAB]
    return MAIN_TABS
  }, [showDebugTab])

  const handleTabClick = (tabId: SettingsTab) => {
    setActiveTab(tabId)
  }

  const handleBack = useCallback(() => {
    setDesktopView(null)
  }, [setDesktopView])

  return (
    <div className="flex flex-col h-full bg-tl-background" data-sidebar-content>
      {/* Back button */}
      <div className="px-2 pt-3 pb-2">
        <button
          onClick={handleBack}
          className="inline-flex items-center gap-2 w-full text-left px-3 py-1.5 text-sm h-7 rounded-md text-muted-foreground hover:text-foreground font-medium transition-colors cursor-pointer"
        >
          <ChevronLeft className="h-4 w-4" />
          <span>{i18n.t('Back')}</span>
        </button>
      </div>

      {/* Tab list */}
      <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-thumb-muted-foreground/20 scrollbar-track-transparent px-2 pb-4 space-y-4">
        {/* Main Tabs */}
        <div className="space-y-1">
          {mainTabs.map((tab) => (
            <TabButton
              key={tab.id}
              tab={tab}
              isActive={activeTab === tab.id}
              onClick={() => handleTabClick(tab.id)}
            />
          ))}
        </div>
      </div>
    </div>
  )
}