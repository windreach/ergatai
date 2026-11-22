// Modified from 1Code (Apache-2.0) by Ergatai — see MODIFICATIONS.md
import i18n from "@/lib/i18n"
import { useEffect, useMemo, useCallback } from "react"
import { useAtomValue, useSetAtom } from "jotai"
import { useTheme } from "next-themes"
import { X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { fullThemeDataAtom } from "@/lib/atoms"
import {
  AgentTerminalOutput,
  useAgentTerminals,
  type AgentTerminalTask,
} from "../agents"
import { activeAgentTerminalIdAtomFamily } from "./atoms"
import { getTerminalThemeFromVSCode, TERMINAL_OPTIONS } from "./config"

export function agentTerminalStatusLabel(task: AgentTerminalTask): string {
  if (task.status === "running") return i18n.t("Running")
  if (task.status === "failed") {
    return task.exitCode != null
      ? `${i18n.t("Failed")} (${task.exitCode})`
      : i18n.t("Failed")
  }
  if (task.status === "cancelled") return i18n.t("Stopped")
  return i18n.t("Completed")
}

function agentTerminalDotClass(task: AgentTerminalTask): string {
  if (task.status === "running") return "animate-pulse bg-blue-500"
  if (task.status === "completed") return "bg-green-500"
  return "bg-red-500"
}

/**
 * Resolve the agent terminal task selected for a terminal scope.
 *
 * Agent tasks live in the shared terminal store, while the selection is
 * per-scope so a chat's terminal sidebar remembers which read-only task was
 * open without competing with the user's active PTY tab.
 */
export function useActiveAgentTerminal(
  scopeKey: string,
  conversationId?: string | null,
) {
  const selectionAtom = useMemo(
    () => activeAgentTerminalIdAtomFamily(scopeKey),
    [scopeKey],
  )
  const activeId = useAtomValue(selectionAtom)
  const setActiveId = useSetAtom(selectionAtom)
  const tasks = useAgentTerminals(conversationId ?? null)

  const activeTask = useMemo(
    () => tasks.find((task) => task.terminalId === activeId) ?? null,
    [tasks, activeId],
  )

  useEffect(() => {
    if (activeId && !activeTask) {
      setActiveId(null)
    }
  }, [activeId, activeTask, setActiveId])

  const clear = useCallback(() => setActiveId(null), [setActiveId])

  return {
    tasks,
    activeId,
    activeTask,
    select: setActiveId,
    clear,
  }
}

/**
 * Terminal theme shared by the pane header and xterm body so agent output
 * matches the regular terminal panel instead of xterm's default colors.
 */
function useAgentTerminalTheme() {
  const { resolvedTheme } = useTheme()
  const isDark = resolvedTheme === "dark"
  const fullThemeData = useAtomValue(fullThemeDataAtom)

  return useMemo(
    () => getTerminalThemeFromVSCode(fullThemeData?.colors, isDark),
    [fullThemeData, isDark],
  )
}

/**
 * Read-only agent task represented in the terminal tab strip.
 *
 * Without this tab the terminal header would only show the close button, mode
 * switcher and plus button, while the task itself rendered a second, duplicate
 * header in the body.
 */
export function AgentTerminalTab({
  task,
  onClose,
  className,
}: {
  task: AgentTerminalTask
  onClose: () => void
  className?: string
}) {
  return (
    <div
      title={task.command || task.title}
      style={{
        // @ts-expect-error - WebKit-specific property for Electron window dragging
        WebkitAppRegion: "no-drag",
      }}
      className={cn(
        "group relative flex h-6 min-w-[120px] max-w-[220px] select-none items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-md bg-muted px-1.5 py-0.5 text-sm text-foreground",
        className,
      )}
    >
      <span
        className={cn(
          "h-1.5 w-1.5 flex-shrink-0 rounded-full",
          agentTerminalDotClass(task),
        )}
      />
      <span className="min-w-0 flex-1 truncate text-left">{task.title}</span>
      <span
        className={cn(
          "shrink-0 text-[10px]",
          task.status === "running"
            ? "text-muted-foreground"
            : task.status === "completed"
              ? "text-green-600 dark:text-green-500"
              : "text-red-600 dark:text-red-500",
        )}
      >
        {agentTerminalStatusLabel(task)}
      </span>
      <button
        type="button"
        onClick={onClose}
        className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground"
        aria-label={i18n.t("Close agent terminal")}
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  )
}

/**
 * Read-only terminal view for an agent-reported background shell.
 */
export function AgentTerminalPane({
  task,
  onClose,
  className,
  showHeader = true,
}: {
  task: AgentTerminalTask
  onClose: () => void
  className?: string
  /** Hidden when the parent renders the task as a tab in its own header. */
  showHeader?: boolean
}) {
  const theme = useAgentTerminalTheme()
  // The adapter often reports the command as the task title, so only render
  // the command line when it adds information.
  const showCommand = !!task.command && task.command !== task.title

  return (
    <div
      className={cn("flex h-full min-h-0 flex-col", className)}
      style={{ backgroundColor: theme.background }}
    >
      {showHeader && (
        <div className="flex flex-shrink-0 items-center gap-2 border-b border-border/40 px-3 py-1.5">
          <span
            className={cn(
              "h-1.5 w-1.5 flex-shrink-0 rounded-full",
              agentTerminalDotClass(task),
            )}
          />
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-medium text-foreground">
              {task.title}
            </div>
            {showCommand ? (
              <div className="truncate font-mono text-[10px] text-muted-foreground">
                {task.command}
              </div>
            ) : null}
          </div>
          <span
            className={cn(
              "flex-shrink-0 text-[10px]",
              task.status === "running"
                ? "text-muted-foreground"
                : task.status === "completed"
                  ? "text-green-600 dark:text-green-500"
                  : "text-red-600 dark:text-red-500",
            )}
          >
            {agentTerminalStatusLabel(task)}
          </span>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            className="h-6 w-6 flex-shrink-0 p-0 text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
            aria-label={i18n.t("Close agent terminal")}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
      {task.output ? (
        <AgentTerminalOutput
          content={task.output}
          theme={theme}
          fontSize={TERMINAL_OPTIONS.fontSize}
          fontFamily={TERMINAL_OPTIONS.fontFamily}
          lineHeight={TERMINAL_OPTIONS.lineHeight}
          className="min-h-0 w-full flex-1"
        />
      ) : (
        <div className="min-h-0 w-full flex-1 overflow-auto px-3 py-2 font-mono text-[13px] leading-[1.4] text-muted-foreground">
          {i18n.t("No output yet")}
        </div>
      )}
    </div>
  )
}
