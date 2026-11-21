// import i18n from "@/lib/i18n" // 暂时隐藏 MCP widget
import { useMemo } from "react"
import { useAtomValue } from "jotai"
import { widgetVisibilityAtomFamily, widgetOrderAtomFamily } from "../atoms"
// import { WidgetCard } from "./widget-card" // 暂时隐藏 MCP widget
import { useExtensionMeta } from "../../agents"
import { AgentsWidget } from "../sections/agents-widget"
import { TodoWidget } from "../sections/todo-widget"
import { PlanWidget } from "../sections/plan-widget"
import { GoalWidget } from "../sections/goal-widget"
import { TerminalWidget } from "../sections/terminal-widget"
import { ChangesWidget } from "../sections/changes-widget"
// import { McpWidget } from "../sections/mcp-widget" // 暂时隐藏 MCP widget
import type { ParsedDiffFile } from "../types"
import type { AgentMode } from "../../agents"
import { getTerminalScopeKey } from "../../terminal"

interface WidgetsPanelProps {
  chatId: string
  /** Runtime agent id for this chat (used for extension metadata). */
  agentId?: string | null
  worktreePath: string | null
  /** Chat branch - used to compute the terminal scope key (must match TerminalSidebar) */
  branch?: string | null
  /** Terminal scope key - must match TerminalSidebar's scopeKey so rail/widget terminals share data */
  terminalScopeKey?: string
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
  agentId,
  worktreePath,
  branch,
  terminalScopeKey,
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

  // Same scope key as TerminalSidebar so the task list maps 1:1 to sidebar terminals.
  // Prefer the explicitly passed scope key (guaranteed to match the rail) and fall
  // back to recomputing from branch/worktree for callers that don't pass it.
  const resolvedTerminalScopeKey =
    terminalScopeKey ??
    getTerminalScopeKey({
      branch: branch ?? null,
      worktreePath,
      id: chatId,
    })

  // Extension metadata is stored by runtime agent id, not chat id.
  const extensionMeta = useExtensionMeta(agentId ?? chatId)
  const asyncTasks = extensionMeta?.["async_tasks_update"]
  const goal = extensionMeta?.["goal"] ?? extensionMeta?.goal

  return (
    <>
      <GoalWidget goal={goal} />
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
                scopeKey={resolvedTerminalScopeKey}
                onExpand={onExpandTerminal}
                conversationId={activeConversationId}
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

          // 暂时隐藏 MCP widget：当前 discovery 只扫描静态配置文件 + registry，
          // 不包含运行时注入的 MCP（如 Ergatai MCP Tools），展示不完整。
          // case "mcp":
          //   return (
          //     <WidgetCard
          //       key="mcp"
          //       widgetId="mcp"
          //       title={i18n.t('MCP Servers')}
          //       hideExpand
          //     >
          //       <McpWidget chatId={chatId} worktreePath={worktreePath} />
          //     </WidgetCard>
          //   )

          default:
            return null
        }
      })}
    </>
  )
}