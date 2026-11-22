// Modified from 1Code (Apache-2.0) by Ergatai — see MODIFICATIONS.md
import i18n from "@/lib/i18n"
import { cn } from "../../../lib/utils"

export const AVAILABLE_TOOLS = [
  // File Operations
  {
    id: "Read",
    name: i18n.t("settings.tools.read.name"),
    category: "file",
    description: i18n.t("settings.tools.read.description"),
  },
  {
    id: "Write",
    name: i18n.t("settings.tools.write.name"),
    category: "file",
    description: i18n.t("settings.tools.write.description"),
  },
  {
    id: "Edit",
    name: i18n.t("settings.tools.edit.name"),
    category: "file",
    description: i18n.t("settings.tools.edit.description"),
  },
  {
    id: "Glob",
    name: i18n.t("settings.tools.glob.name"),
    category: "file",
    description: i18n.t("settings.tools.glob.description"),
  },
  {
    id: "Grep",
    name: i18n.t("settings.tools.grep.name"),
    category: "file",
    description: i18n.t("settings.tools.grep.description"),
  },
  {
    id: "NotebookEdit",
    name: i18n.t("settings.tools.notebookEdit.name"),
    category: "file",
    description: i18n.t("settings.tools.notebookEdit.description"),
  },

  // System
  {
    id: "Bash",
    name: i18n.t("settings.tools.bash.name"),
    category: "system",
    description: i18n.t("settings.tools.bash.description"),
  },
  {
    id: "Task",
    name: i18n.t("settings.tools.task.name"),
    category: "system",
    description: i18n.t("settings.tools.task.description"),
  },

  // Web
  {
    id: "WebSearch",
    name: i18n.t("settings.tools.webSearch.name"),
    category: "web",
    description: i18n.t("settings.tools.webSearch.description"),
  },
  {
    id: "WebFetch",
    name: i18n.t("settings.tools.webFetch.name"),
    category: "web",
    description: i18n.t("settings.tools.webFetch.description"),
  },

  // Planning & Interaction
  {
    id: "TodoWrite",
    name: i18n.t("settings.tools.todoWrite.name"),
    category: "planning",
    description: i18n.t("settings.tools.todoWrite.description"),
  },
  {
    id: "AskUserQuestion",
    name: i18n.t("settings.tools.askUser.name"),
    category: "planning",
    description: i18n.t("settings.tools.askUser.description"),
  },
]

const CATEGORIES = [
  { id: "file", name: i18n.t("settings.tools.categories.file") },
  { id: "system", name: i18n.t("settings.tools.categories.system") },
  { id: "web", name: i18n.t("settings.tools.categories.web") },
  { id: "planning", name: i18n.t("settings.tools.categories.planning") },
]

interface ToolSelectorProps {
  selectedTools: string[]
  onChange: (tools: string[]) => void
  mode: "allowlist" | "denylist"
}

export function ToolSelector({ selectedTools, onChange, mode }: ToolSelectorProps) {
  const handleToggle = (toolId: string) => {
    if (selectedTools.includes(toolId)) {
      onChange(selectedTools.filter((t) => t !== toolId))
    } else {
      onChange([...selectedTools, toolId])
    }
  }

  const handleSelectAll = () => {
    onChange(AVAILABLE_TOOLS.map((t) => t.id))
  }

  const handleSelectNone = () => {
    onChange([])
  }

  return (
    <div className="space-y-3">
      {/* Quick actions */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={handleSelectAll}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          {i18n.t("settings.tools.selectAll")}
        </button>
        <span className="text-muted-foreground">·</span>
        <button
          type="button"
          onClick={handleSelectNone}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          {i18n.t("settings.tools.clear")}
        </button>
        <span className="flex-1" />
        <span className="text-xs text-muted-foreground">
          {i18n.t("settings.tools.selectedCount", { count: selectedTools.length })}
        </span>
      </div>

      {/* Tools by category */}
      <div className="space-y-4 p-3 rounded-lg border border-border bg-muted/20">
        {CATEGORIES.map((category) => {
          const categoryTools = AVAILABLE_TOOLS.filter((t) => t.category === category.id)
          if (categoryTools.length === 0) return null

          return (
            <div key={category.id} className="space-y-2">
              <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                {category.name}
              </div>
              <div className="grid grid-cols-2 gap-2">
                {categoryTools.map((tool) => {
                  // react-doctor-disable-next-line js-set-map-lookups
                  const isSelected = selectedTools.includes(tool.id)
                  return (
                    <button
                      key={tool.id}
                      type="button"
                      onClick={() => handleToggle(tool.id)}
                      className={cn(
                        "flex items-start gap-2 p-2 rounded-md border text-left transition-colors",
                        isSelected
                          ? mode === "allowlist"
                            ? "border-green-500/30 bg-green-500/10"
                            : "border-red-500/30 bg-red-500/10"
                          : "border-transparent bg-background hover:bg-foreground/5"
                      )}
                    >
                      <div
                        className={cn(
                          "mt-0.5 h-3.5 w-3.5 rounded border flex items-center justify-center flex-shrink-0",
                          isSelected
                            ? mode === "allowlist"
                              ? "border-green-500 bg-green-500"
                              : "border-red-500 bg-red-500"
                            : "border-muted-foreground/30"
                        )}
                      >
                        {isSelected && (
                          <svg
                            className="h-2.5 w-2.5 text-white"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={3}
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              d="M5 13l4 4L19 7"
                            />
                          </svg>
                        )}
                      </div>
                      <div className="min-w-0">
                        <div className="text-xs font-medium text-foreground truncate">
                          {tool.name}
                        </div>
                        <div className="text-[10px] text-muted-foreground truncate">
                          {tool.description}
                        </div>
                      </div>
                    </button>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>

      {/* Hint */}
      <p className="text-xs text-muted-foreground">
        {mode === "allowlist"
          ? i18n.t("settings.tools.allowlistHint")
          : i18n.t("settings.tools.denylistHint")}
      </p>
    </div>
  )
}