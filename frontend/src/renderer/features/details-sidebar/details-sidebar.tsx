"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useAtom, useAtomValue, useSetAtom } from "jotai"
import { ResizableSidebar } from "@/components/ui/resizable-sidebar"
import { cn } from "@/lib/utils"
import {
  detailsSidebarOpenAtom,
  detailsSidebarWidthAtom,
  detailsSidebarTabAtom,
} from "./atoms"
import {
  panelLinkCommandAtomFamily,
  createPanelLinkScopeKey,
} from "@/features/panel-link"
import { FilesTab, type FilesTabHandle } from "./sections/files-tab"
import type { ParsedDiffFile } from "./types"
import { fileViewerOpenAtomFamily, type AgentMode } from "../agents/atoms"
import { DetailsSidebarHeader } from "./components/details-sidebar-header"
import { WidgetsPanel } from "./components/widgets-panel"
import { DiffPageView } from "../changes/diff-page-view"
import { ChangesPanel } from "../changes/changes-panel"
import { GitStatusBar } from "../changes/components/git-status-bar"
import { preferredEditorAtom } from "@/lib/atoms"
import { trpc } from "../../lib/trpc"

interface DetailsSidebarProps {
  /** Workspace/chat ID */
  chatId: string
  /** Worktree path for terminal */
  worktreePath: string | null
  /** Chat branch - used to key terminal sessions (must match TerminalSidebar) */
  branch?: string | null
  /** Plan path for plan section */
  planPath: string | null
  /** Current agent mode (plan or agent) */
  mode: AgentMode
  /** Callback when "Build plan" is clicked */
  onBuildPlan?: () => void
  /** Plan refetch trigger */
  planRefetchTrigger?: number
  /** Active conversation ID for plan */
  activeConversationId?: string | null
  /** Sidebar open states - used to hide widgets when their sidebar is open */
  isPlanSidebarOpen?: boolean
  isTerminalSidebarOpen?: boolean
  isDiffSidebarOpen?: boolean
  /** Diff display mode - only hide widget when in side-peek mode */
  diffDisplayMode?: "side-peek" | "center-peek" | "full-page"
  /** Diff-related props */
  canOpenDiff: boolean
  diffStats?: { additions: number; deletions: number; fileCount: number } | null
  /** Parsed diff files for file list */
  parsedFileDiffs?: ParsedDiffFile[] | null
  /** Callback to commit selected changes */
  onCommit?: (selectedPaths: string[]) => void
  /** Callback to commit and push selected changes */
  onCommitAndPush?: (selectedPaths: string[]) => void
  /** Whether commit is in progress */
  isCommitting?: boolean
  /** Git sync status for push/pull actions */
  gitStatus?: { pushCount?: number; pullCount?: number; hasUpstream?: boolean } | null
  /** Whether git sync status is loading */
  isGitStatusLoading?: boolean
  /** Current branch name for header */
  currentBranch?: string
  /** Callbacks to expand widgets to legacy sidebars */
  onExpandTerminal?: () => void
  onExpandPlan?: () => void
  onExpandDiff?: () => void
  /** Callback when a file is selected in Changes widget - opens diff with file selected */
  onFileSelect?: (filePath: string) => void
  /** Callback when a file is opened from Files tab - opens in file viewer */
  onOpenFile?: (absolutePath: string) => void
  /** Remote chat info for sandbox workspaces */
  remoteInfo?: {
    repository?: string
    branch?: string | null
    sandboxId?: string
  } | null
  /** Whether this is a remote sandbox chat (no local worktree) */
  isRemoteChat?: boolean
  /**
   * Hide the resize handle, e.g. while the file viewer owns the boundary
   * between the two sidebars.
   */
  hideResizeHandle?: boolean
}

export function DetailsSidebar({
  chatId,
  worktreePath,
  branch,
  planPath,
  mode,
  onBuildPlan,
  planRefetchTrigger,
  activeConversationId,
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
  onOpenFile,
  remoteInfo,
  isRemoteChat = false,
  hideResizeHandle = false,
}: DetailsSidebarProps) {
  // Global sidebar open state
  const [isOpen, setIsOpen] = useAtom(detailsSidebarOpenAtom)

  // Active tab state (Details / Files / Git). The side chat used to be a tab;
  // a stale persisted "chat" value falls back to the Details page.
  const [storedTab] = useAtom(detailsSidebarTabAtom)
  const activeTab = storedTab === ("chat" as typeof storedTab) ? "details" : storedTab
  const panelLinkScopeKey = createPanelLinkScopeKey({ chatId })
  const dispatchPanelLink = useSetAtom(
    panelLinkCommandAtomFamily(panelLinkScopeKey),
  )

  // Files tab ref for header actions
  const filesTabRef = useRef<FilesTabHandle>(null)
  const [filesAllExpanded, setFilesAllExpanded] = useState(false)

  useEffect(() => {
    dispatchPanelLink({
      type: "sync-panel",
      panelId: "details",
      open: isOpen,
      target: {
        kind: "widget",
        id: `details:${activeTab}`,
        chatId,
      },
      source: "migration",
      displayMode: activeTab,
    })
  }, [activeTab, chatId, dispatchPanelLink, isOpen])

  // Current file open in file viewer (for tree highlight sync)
  const fileViewerAtom = useMemo(() => fileViewerOpenAtomFamily(chatId), [chatId])
  const fileViewerPath = useAtomValue(fileViewerAtom)

  // Close sidebar callback
  const closeSidebar = useCallback(() => {
    setIsOpen(false)
  }, [setIsOpen])

  // Keyboard shortcut: Cmd+Shift+\ to toggle details sidebar
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.metaKey &&
        e.shiftKey &&
        !e.altKey &&
        !e.ctrlKey &&
        e.code === "Backslash"
      ) {
        e.preventDefault()
        e.stopPropagation()
        setIsOpen(!isOpen)
      }
    }

    window.addEventListener("keydown", handleKeyDown, true)
    return () => window.removeEventListener("keydown", handleKeyDown, true)
  }, [setIsOpen, isOpen])

  // Views without their own file-open handler (e.g. the project view)
  // fall back to opening files in the user's preferred editor.
  const openInAppMutation = trpc.external.openInApp.useMutation()
  const preferredEditor = useAtomValue(preferredEditorAtom)
  const openFileInEditor = useCallback(
    (absolutePath: string) => {
      openInAppMutation.mutate({ path: absolutePath, app: preferredEditor })
    },
    [openInAppMutation, preferredEditor],
  )

  return (
    <ResizableSidebar
      isOpen={isOpen}
      onClose={closeSidebar}
      widthAtom={detailsSidebarWidthAtom}
      side="right"
      minWidth={250}
      maxWidth={700}
      animationDuration={0.24}
      initialWidth={0}
      exitWidth={0}
      persistContent={true}
      showResizeTooltip={true}
      hideResizeHandle={hideResizeHandle}
      className="bg-tl-background border-l"
      style={{ borderLeftWidth: "0.5px", overflow: "hidden" }}
    >
      <div className="flex flex-col h-full min-w-0 overflow-hidden">
        <DetailsSidebarHeader
          chatId={chatId}
          activeTab={activeTab}
          onClose={closeSidebar}
          isRemoteChat={isRemoteChat}
          filesAllExpanded={filesAllExpanded}
          onOpenFileSearch={() => filesTabRef.current?.openSearch()}
          onToggleFilesExpandCollapse={() =>
            filesTabRef.current?.toggleExpandCollapse()
          }
        />

        {/* Tab content — all tabs stay mounted to preserve state */}
        <div className={cn("flex-1 overflow-y-auto py-2", activeTab !== "details" && "hidden")}>
          <WidgetsPanel
            chatId={chatId}
            worktreePath={worktreePath}
            branch={branch}
            planPath={planPath}
            activeConversationId={activeConversationId}
            mode={mode}
            onBuildPlan={onBuildPlan}
            planRefetchTrigger={planRefetchTrigger}
            isPlanSidebarOpen={isPlanSidebarOpen}
            isTerminalSidebarOpen={isTerminalSidebarOpen}
            isDiffSidebarOpen={isDiffSidebarOpen}
            diffDisplayMode={diffDisplayMode}
            canOpenDiff={canOpenDiff}
            diffStats={diffStats}
            parsedFileDiffs={parsedFileDiffs}
            onCommit={onCommit}
            onCommitAndPush={onCommitAndPush}
            isCommitting={isCommitting}
            gitStatus={gitStatus}
            isGitStatusLoading={isGitStatusLoading}
            currentBranch={currentBranch}
            onExpandTerminal={onExpandTerminal}
            onExpandPlan={onExpandPlan}
            onExpandDiff={onExpandDiff}
            onFileSelect={onFileSelect}
            remoteInfo={remoteInfo}
            isRemoteChat={isRemoteChat}
          />
        </div>
        <FilesTab
          ref={filesTabRef}
          worktreePath={worktreePath}
          onSelectFile={onOpenFile ?? openFileInEditor}
          onExpandedStateChange={setFilesAllExpanded}
          currentViewerFilePath={fileViewerPath}
          className={cn("flex-1", activeTab !== "files" && "hidden")}
        />
        <div
          className={cn(
            "flex min-h-0 flex-1 flex-col",
            activeTab !== "git" && "hidden",
          )}
        >
          {worktreePath ? (
            <>
              <GitStatusBar worktreePath={worktreePath} />
              <ChangesPanel
                worktreePath={worktreePath}
                chatId={chatId}
              />
            </>
          ) : null}
        </div>
      </div>
    </ResizableSidebar>
  )
}
