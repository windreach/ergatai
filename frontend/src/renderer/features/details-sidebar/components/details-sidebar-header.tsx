import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  IconDoubleChevronRight,
  SearchIcon,
  ExpandIcon,
  CollapseIcon,
} from "@/components/ui/icons"
import { Kbd } from "@/components/ui/kbd"
import { useResolvedHotkeyDisplay } from "@/lib/hotkeys"
import type { DetailsSidebarTab } from "../atoms"
import { WidgetSettingsPopup } from "../widget-settings-popup"

// The sidebar shows one independent page at a time (Details widgets, Files
// or Git changes) — there is no tab bar. Files / Git are opened from icon
// buttons in the main chat header. The header simply titles the active page.
const VIEW_TITLES: Record<DetailsSidebarTab, string> = {
  details: "Details",
  files: "Files",
  git: "Git",
}

interface DetailsSidebarHeaderProps {
  chatId: string
  activeTab: DetailsSidebarTab
  onClose: () => void
  isRemoteChat?: boolean
  filesAllExpanded: boolean
  onOpenFileSearch: () => void
  onToggleFilesExpandCollapse: () => void
}

export function DetailsSidebarHeader({
  chatId,
  activeTab,
  onClose,
  isRemoteChat = false,
  filesAllExpanded,
  onOpenFileSearch,
  onToggleFilesExpandCollapse,
}: DetailsSidebarHeaderProps) {
  const toggleDetailsHotkey = useResolvedHotkeyDisplay("toggle-details")
  const fileSearchHotkey = useResolvedHotkeyDisplay("file-search")

  return (
    <div className="flex items-center justify-between px-2 h-10 bg-tl-background flex-shrink-0 border-b border-border/50">
      <div className="flex items-center gap-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onClick={onClose}
              className="h-6 w-6 p-0 hover:bg-foreground/10 transition-[background-color,transform] duration-150 ease-out active:scale-[0.97] text-foreground flex-shrink-0 rounded-md"
              aria-label="Close details"
            >
              <IconDoubleChevronRight className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            Close details
            {toggleDetailsHotkey && <Kbd>{toggleDetailsHotkey}</Kbd>}
          </TooltipContent>
        </Tooltip>

        {/* Current page title */}
        <span className="text-xs font-medium text-foreground">
          {VIEW_TITLES[activeTab]}
        </span>
      </div>

      {/* Right-side header actions */}
      {activeTab === "details" ? (
        <WidgetSettingsPopup workspaceId={chatId} isRemoteChat={isRemoteChat} />
      ) : activeTab === "files" ? (
        <div className="flex items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={onOpenFileSearch}
                className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
              >
                <SearchIcon className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              Search files
              {fileSearchHotkey && <Kbd>{fileSearchHotkey}</Kbd>}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={onToggleFilesExpandCollapse}
                className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
              >
                {filesAllExpanded ? (
                  <CollapseIcon className="size-3.5" />
                ) : (
                  <ExpandIcon className="size-3.5" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {filesAllExpanded ? "Collapse all" : "Expand all"}
            </TooltipContent>
          </Tooltip>
        </div>
      ) : null}
    </div>
  )
}
