import { useMemo } from "react"
import { useAtomValue } from "jotai"
import { widgetVisibilityAtomFamily, widgetOrderAtomFamily } from "../atoms"
import { WidgetCard } from "./widget-card"
import { AgentsWidget } from "../sections/agents-widget"
import { TodoWidget } from "../sections/todo-widget"
import { PlanWidget } from "../sections/plan-widget"
import { TerminalWidget } from "../sections/terminal-widget"
import { ChangesWidget } from "../sections/changes-widget"
// Temporarily disabled: MCP widget is session-scoped and too limited for multi-agent use.
// import { McpWidget } from "../sections/mcp-widget"
import type { ParsedDiffFile } from "../types"
import type { AgentMode } from "../../agents"
import { getTerminalScopeKey } from "../../terminal"

interface WidgetsPanelProps {
  chatId: string
  worktreePath: string | null
  /** Chat branch - used to compute the terminal scope key (must match TerminalSidebar) */
  branch?: string | null
  planPath: string | null
  activeConversationId?: string | null
  mode: AgentMode
  onBuildPlan?: () => void
  planRefetchTrigger?: number
  /** Sidebar open states - used to hide widgets when their sidebar is open */
  isPlanSidebarOpen?: boolean
  isTerminalSidebarOpen?: boolean
  isDiffSidebarOpen?: boolean
  /** Diff display mode - only hide widget when in side-peek mode */
  diffDisplayMode?: "side-peek" | "center-peek" | "full-page"
  canOpenDiff: boolean
  diffStats?: { additions: number; deletions: number; fileCount: number } | null
  parsedFileDiffs?: ParsedDiffFile[] | null
  onCommit?: (selectedPaths: string[]) => void
  onCommitAndPush?: (selectedPaths: string[]) => void
  isCommitting?: boolean
  gitStatus?: { pushCount?: number; pullCount?: number; hasUpstream?: boolean } | null
  isGitStatusLoading?: boolean
  currentBranch?: string
  onExpandTerminal?: () => void
  onExpandPlan?: () => void
  onExpandDiff?: () => void
  onFileSelect?: (filePath: string) => void
  remoteInfo?: {
    repository?: string
    branch?: string | null
    sandboxId?: string
  } | null
  isRemoteChat?: boolean
}

export function WidgetsPanel({
  chatId,
  worktreePath,
  branch,
  planPath,
  activeConversationId,
  mode,
  onBuildPlan,
  planRefetchTrigger,
  isPlanSidebarOpen,
  isTerminalSidebarOpen,
  isDiffSidebarOpen,
  diffDisplayMode,
  canOpenDiff,
  diffStats,
  parsedFileDiffs,
  onCommit,
  onCommitAndPush,
  isCommitting,
  gitStatus,
  isGitStatusLoading,
  currentBranch,
  onExpandTerminal,
  onExpandPlan,
  onExpandDiff,
  onFileSelect,
  remoteInfo,
  isRemoteChat = false,
}: WidgetsPanelProps) {
  // Per-workspace widget visibility & order
  const widgetVisibilityAtom = useMemo(
    () => widgetVisibilityAtomFamily(chatId),
    [chatId],
  )
  const visibleWidgets = useAtomValue(widgetVisibilityAtom)

  const widgetOrderAtom = useMemo(
    () => widgetOrderAtomFamily(chatId),
    [chatId],
  )
  const widgetOrder = useAtomValue(widgetOrderAtom)

  // Same scope key as TerminalSidebar so the task list maps 1:1 to sidebar terminals
  const terminalScopeKey = getTerminalScopeKey({
    branch: branch ?? null,
    worktreePath,
    id: chatId,
  })

  return (
    <>
      {widgetOrder.map((widgetId) => {
        // Skip if widget is not visible
        // react-doctor-disable-next-line js-set-map-lookups
        if (!visibleWidgets.includes(widgetId)) return null

        switch (widgetId) {
          case "agents":
            return (
              <AgentsWidget
                key="agents"
                chatId={chatId}
                activeConversationId={activeConversationId}
              />
            )

          case "info":
            return null

          case "todo":
            return (
              <TodoWidget key="todo" conversationId={activeConversationId || null} />
            )

          case "plan":
            // Hidden when Plan sidebar is open
            if (!planPath || isPlanSidebarOpen) return null
            return (
              <PlanWidget
                key="plan"
                chatId={chatId}
                activeConversationId={activeConversationId}
                planPath={planPath}
                refetchTrigger={planRefetchTrigger}
                mode={mode}
                onApprovePlan={onBuildPlan}
                onExpandPlan={onExpandPlan}
              />
            )

          case "terminal":
            // Hidden when Terminal sidebar is open
            if (!worktreePath || isTerminalSidebarOpen) return null
            return (
              <TerminalWidget
                key="terminal"
                scopeKey={terminalScopeKey}
                onExpand={onExpandTerminal}
              />
            )

          case "diff":
            // Show widget if we have diff stats (local or remote)
            // Hide only when Diff sidebar is open in side-peek mode
            const hasDiffStats = !!diffStats && (diffStats.fileCount > 0 || diffStats.additions > 0 || diffStats.deletions > 0)
            const canShowDiffWidget = canOpenDiff || (isRemoteChat && hasDiffStats)
            if (!canShowDiffWidget || (isDiffSidebarOpen && diffDisplayMode === "side-peek")) return null
            return (
              <ChangesWidget
                key="diff"
                chatId={chatId}
                worktreePath={worktreePath}
                diffStats={diffStats}
                parsedFileDiffs={parsedFileDiffs}
                onCommit={onCommit}
                onCommitAndPush={onCommitAndPush}
                isCommitting={isCommitting}
                pushCount={gitStatus?.pushCount ?? 0}
                pullCount={gitStatus?.pullCount ?? 0}
                hasUpstream={gitStatus?.hasUpstream ?? true}
                isSyncStatusLoading={isGitStatusLoading}
                currentBranch={currentBranch}
                // For remote chats on desktop, don't provide expand/file actions
                onExpand={canOpenDiff ? onExpandDiff : undefined}
                onFileSelect={canOpenDiff ? onFileSelect : undefined}
                diffDisplayMode={diffDisplayMode}
              />
            )

          // Temporarily disabled: MCP widget is session-scoped and too limited for multi-agent use.
          // case "mcp":
          //   return (
          //     <WidgetCard
          //       key="mcp"
          //       widgetId="mcp"
          //       title="MCP Servers"
          //       hideExpand
          //     >
          //       <McpWidget />
          //     </WidgetCard>
          //   )
          case "mcp":
            return null

          case "monitoring":
            return null

          default:
            return null
        }
      })}
    </>
  )
}
