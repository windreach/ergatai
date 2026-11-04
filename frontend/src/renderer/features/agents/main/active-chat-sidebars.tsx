"use client"

import { Button } from "../../../components/ui/button"
import { ResizableSidebar } from "../../../components/ui/resizable-sidebar"
import { IconCloseSidebarRight } from "../../../components/ui/icons"
import { DiffCenterPeekDialog } from "../../changes"
import { DiffFullPageView } from "../../changes"
import { DetailsSidebar } from "../../details-sidebar"
import { SideChatSidebar } from "../../details-sidebar"
import { FileViewerSidebar } from "../../file-viewer"
import { TerminalSidebar } from "../../terminal"
import {
  agentsPlanSidebarWidthAtom,
  agentsPreviewSidebarWidthAtom,
  fileViewerSidebarWidthAtom,
} from "../atoms"
import {
  DiffStateProvider,
  DiffSidebarRenderer,
} from "../components/diff/diff-components"
import { AgentPlanSidebar } from "../ui/agent-plan-sidebar"
import { AgentPreview } from "../ui/agent-preview"

 
export function ChatViewSidebars(props: any) {
  const {
    isMobileFullscreen,
    activeConversationId,
    isPlanSidebarOpen,
    setIsPlanSidebarOpen,
    currentPlanPath,
    handleApprovePlanFromSidebar,
    currentMode,
    canOpenDiff,
    chatId,
    worktreePath,
    sandboxId,
    repository,
    isDiffSidebarOpen,
    setIsDiffSidebarOpen,
    diffStats,
    setDiffStats,
    diffContent,
    setDiffContent,
    parsedFileDiffs,
    setParsedFileDiffs,
    prefetchedFileContents,
    setPrefetchedFileContents,
    fetchDiffStats,
    isDiffSidebarNarrow,
    setDiffCollapseState,
    diffViewRef,
    diffSidebarRef,
    branchData,
    gitStatus,
    isGitStatusLoading,
    diffDisplayMode,
    diffSidebarWidth,
    handleReview,
    isReviewing,
    handleCreatePrDirect,
    handleCreatePr,
    isCreatingPr,
    handleMergePr,
    mergePrMutation,
    handleRefreshGitStatus,
    hasPrNumber,
    isPrOpen,
    hasMergeConflicts,
    handleFixConflicts,
    handleExpandAll,
    handleCollapseAll,
    diffMode,
    setDiffMode,
    handleMarkAllViewed,
    handleMarkAllUnviewed,
    isDesktop,
    isFullscreen,
    setDiffDisplayMode,
    handleCommitToPr,
    isCommittingToPr,
    conversationsWithFiles,
    scheduleDiffRefresh,
    canOpenPreview,
    isPreviewSidebarOpen,
    setIsPreviewSidebarOpen,
    isQuickSetup,
    previewPort,
    setLinkedFileViewerPath,
    fileViewerPath,
    fileViewerDisplayMode,
    terminalScopeKey,
    isUnifiedSidebarEnabled,
    meta,
    isTerminalSidebarOpen,
    setIsTerminalSidebarOpen,
    _terminalDisplayMode,
    _toggleTerminalHotkey,
    isCommittingCombined,
    dispatchPanelLink,
    selectedFilePath,
    setSelectedFilePath,
    setFilteredDiffFiles,
    handleCommitChanges,
    handleCommitAndPush,
  } = props

  return (
    <>
        {/* Plan Sidebar - shows plan files on the right (leftmost right sidebar) */}
        {/* Only show when we have an active conversation with a plan */}
        {!isMobileFullscreen && activeConversationId && (
          <ResizableSidebar
            isOpen={isPlanSidebarOpen && !!currentPlanPath}
            onClose={() => setIsPlanSidebarOpen(false)}
            widthAtom={agentsPlanSidebarWidthAtom}
            minWidth={400}
            maxWidth={800}
            side="right"
            animationDuration={0.24}
            initialWidth={0}
            exitWidth={0}
            showResizeTooltip={true}
            className="bg-tl-background border-l"
            style={{ borderLeftWidth: "0.5px" }}
          >
            <AgentPlanSidebar
              chatId={chatId}
              conversationId={activeConversationId}
              planPath={currentPlanPath}
              onClose={() => setIsPlanSidebarOpen(false)}
              onBuildPlan={handleApprovePlanFromSidebar}
              mode={currentMode}
            />
          </ResizableSidebar>
        )}

        {/* Diff View - hidden on mobile fullscreen and when diff is not available */}
        {/* Supports three display modes: side-peek (sidebar), center-peek (dialog), full-page */}
        {/* Wrapped in DiffStateProvider to isolate diff state and prevent ChatView re-renders */}
        {canOpenDiff && !isMobileFullscreen && (
          <DiffStateProvider
            chatId={chatId}
            worktreePath={worktreePath}
            isDiffSidebarOpen={isDiffSidebarOpen}
            parsedFileDiffs={parsedFileDiffs}
            isDiffSidebarNarrow={isDiffSidebarNarrow}
            setIsDiffSidebarOpen={setIsDiffSidebarOpen}
            setDiffStats={setDiffStats}
            setDiffContent={setDiffContent}
            setParsedFileDiffs={setParsedFileDiffs}
            setPrefetchedFileContents={setPrefetchedFileContents}
            fetchDiffStats={fetchDiffStats}
          >
            <DiffSidebarRenderer
              worktreePath={worktreePath}
              chatId={chatId}
              sandboxId={sandboxId}
              repository={repository ?? null}
              diffStats={diffStats}
              diffContent={diffContent}
              parsedFileDiffs={parsedFileDiffs}
              prefetchedFileContents={prefetchedFileContents}
              setDiffCollapseState={setDiffCollapseState}
              diffViewRef={diffViewRef}
              diffSidebarRef={diffSidebarRef}
              agentChat={null}
              branchData={branchData}
              gitStatus={gitStatus}
              isGitStatusLoading={isGitStatusLoading}
              isDiffSidebarOpen={isDiffSidebarOpen}
              diffDisplayMode={diffDisplayMode}
              diffSidebarWidth={diffSidebarWidth}
              handleReview={handleReview}
              isReviewing={isReviewing}
              handleCreatePrDirect={handleCreatePrDirect}
              handleCreatePr={handleCreatePr}
              isCreatingPr={isCreatingPr}
              handleMergePr={handleMergePr}
              mergePrMutation={mergePrMutation}
              handleRefreshGitStatus={handleRefreshGitStatus}
              hasPrNumber={hasPrNumber}
              isPrOpen={isPrOpen}
              hasMergeConflicts={hasMergeConflicts}
              handleFixConflicts={handleFixConflicts}
              handleExpandAll={handleExpandAll}
              handleCollapseAll={handleCollapseAll}
              diffMode={diffMode}
              setDiffMode={setDiffMode}
              handleMarkAllViewed={handleMarkAllViewed}
              handleMarkAllUnviewed={handleMarkAllUnviewed}
              isDesktop={isDesktop}
              isFullscreen={isFullscreen ?? false}
              setDiffDisplayMode={setDiffDisplayMode}
              handleCommitToPr={handleCommitToPr}
              isCommittingToPr={isCommittingToPr}
              conversationsWithFiles={conversationsWithFiles}
              setDiffStats={setDiffStats}
              onDiscardSuccess={scheduleDiffRefresh}
            />
          </DiffStateProvider>
        )}

        {/* Preview Sidebar - hidden on mobile fullscreen and when preview is not available */}
        {canOpenPreview && !isMobileFullscreen && (
          <ResizableSidebar
            isOpen={isPreviewSidebarOpen}
            onClose={() => setIsPreviewSidebarOpen(false)}
            widthAtom={agentsPreviewSidebarWidthAtom}
            minWidth={350}
            side="right"
            animationDuration={0.24}
            initialWidth={0}
            exitWidth={0}
            showResizeTooltip={true}
            className="bg-tl-background border-l"
            style={{ borderLeftWidth: "0.5px" }}
          >
            {isQuickSetup ? (
              <div className="flex flex-col h-full">
                {/* Header with close button */}
                <div className="flex items-center justify-end px-3 h-10 bg-tl-background flex-shrink-0 border-b border-border/50">
                  <Button
                    variant="ghost"
                    className="h-7 w-7 p-0 hover:bg-muted transition-[background-color,transform] duration-150 ease-out active:scale-[0.97] rounded-md"
                    onClick={() => setIsPreviewSidebarOpen(false)}
                  >
                    <IconCloseSidebarRight className="h-4 w-4 text-muted-foreground" />
                  </Button>
                </div>
                {/* Content */}
                <div className="flex flex-col items-center justify-center flex-1 p-6 text-center">
                  <div className="text-muted-foreground mb-4">
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      width="48"
                      height="48"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="opacity-50"
                    >
                      <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                      <line x1="8" y1="21" x2="16" y2="21" />
                      <line x1="12" y1="17" x2="12" y2="21" />
                    </svg>
                  </div>
                  <p className="text-sm text-muted-foreground mb-2">
                    Preview not available
                  </p>
                  <p className="text-xs text-muted-foreground/70 max-w-[200px]">
                    Set up this repository to enable live preview
                  </p>
                </div>
              </div>
            ) : (
              <AgentPreview
                chatId={chatId}
                sandboxId={sandboxId}
                port={previewPort}
                hideHeader={false}
                onClose={() => setIsPreviewSidebarOpen(false)}
              />
            )}
          </ResizableSidebar>
        )}

        {/* File Viewer - opens when a file is clicked */}
        {!isMobileFullscreen && fileViewerPath && worktreePath && fileViewerDisplayMode === "side-peek" && (
          <ResizableSidebar
            isOpen={!!fileViewerPath}
            onClose={() => setLinkedFileViewerPath(null)}
            widthAtom={fileViewerSidebarWidthAtom}
            minWidth={350}
            maxWidth={900}
            side="right"
            animationDuration={0.24}
            initialWidth={0}
            exitWidth={0}
            outerResizeHandle
            showResizeTooltip={true}
            className="bg-tl-background border-l"
            style={{ borderLeftWidth: "0.5px" }}
          >
            <FileViewerSidebar
              filePath={fileViewerPath}
              projectPath={worktreePath}
              onClose={() => setLinkedFileViewerPath(null)}
            />
          </ResizableSidebar>
        )}
        {fileViewerPath && worktreePath && fileViewerDisplayMode === "center-peek" && (
          <DiffCenterPeekDialog
            isOpen={!!fileViewerPath}
            onClose={() => setLinkedFileViewerPath(null)}
          >
            <FileViewerSidebar
              filePath={fileViewerPath}
              projectPath={worktreePath}
              onClose={() => setLinkedFileViewerPath(null)}
            />
          </DiffCenterPeekDialog>
        )}
        {fileViewerPath && worktreePath && fileViewerDisplayMode === "full-page" && (
          <DiffFullPageView
            isOpen={!!fileViewerPath}
            onClose={() => setLinkedFileViewerPath(null)}
          >
            <FileViewerSidebar
              filePath={fileViewerPath}
              projectPath={worktreePath}
              onClose={() => setLinkedFileViewerPath(null)}
            />
          </DiffFullPageView>
        )}

        {/* Terminal Sidebar - shows when worktree exists (desktop only) */}
        {worktreePath && (
          <TerminalSidebar
            chatId={chatId}
            scopeKey={terminalScopeKey}
            cwd={worktreePath}
            workspaceId={chatId}
          />
        )}

        {/* Side Chat Sidebar - independent sidebar for agent side chats, coexists with Details */}
        {isUnifiedSidebarEnabled && !isMobileFullscreen && (
          <SideChatSidebar chatId={chatId} />
        )}

        {/* Unified Details Sidebar - combines all right sidebars into one (rightmost) */}
        {isUnifiedSidebarEnabled && !isMobileFullscreen && worktreePath && (
          <DetailsSidebar
            chatId={chatId}
            worktreePath={worktreePath}
            branch={meta?.branch ?? null}
            planPath={currentPlanPath}
            mode={currentMode}
            onBuildPlan={handleApprovePlanFromSidebar}
            activeConversationId={activeConversationId}
            isPlanSidebarOpen={isPlanSidebarOpen && !!currentPlanPath}
            isTerminalSidebarOpen={isTerminalSidebarOpen}
            isDiffSidebarOpen={isDiffSidebarOpen}
            diffDisplayMode={diffDisplayMode}
            canOpenDiff={canOpenDiff}
            diffStats={diffStats}
            parsedFileDiffs={parsedFileDiffs}
            onCommit={worktreePath ? handleCommitChanges : undefined}
            onCommitAndPush={worktreePath ? handleCommitAndPush : undefined}
            isCommitting={isCommittingCombined}
            gitStatus={gitStatus}
            isGitStatusLoading={isGitStatusLoading}
            currentBranch={branchData?.current}
            onExpandTerminal={() => {
              dispatchPanelLink({
                type: "open-panel",
                panelId: "terminal",
                source: "user",
                target: {
                  kind: "terminal",
                  id: terminalScopeKey,
                  chatId,
                  workspaceId: worktreePath ?? undefined,
                },
              })
              setIsTerminalSidebarOpen(true)
            }}
            onExpandPlan={() => {
              dispatchPanelLink({
                type: "open-panel",
                panelId: "plan",
                source: "user",
                target: currentPlanPath
                  ? {
                      kind: "plan",
                      id: currentPlanPath,
                      path: currentPlanPath,
                      chatId,
                      workspaceId: worktreePath ?? undefined,
                    }
                    : { kind: "plan", id: activeConversationId || chatId, chatId },
              })
              setIsPlanSidebarOpen(true)
            }}
            onExpandDiff={() => {
              dispatchPanelLink({
                type: "open-panel",
                panelId: "diff",
                source: "user",
                target: selectedFilePath
                  ? {
                      kind: "diff",
                      id: selectedFilePath,
                      path: selectedFilePath,
                      chatId,
                  workspaceId: worktreePath ?? undefined,
                    }
                  : { kind: "diff", id: chatId, chatId, workspaceId: worktreePath ?? undefined },
              })
              setIsDiffSidebarOpen(true)
            }}
            onFileSelect={(filePath) => {
              setSelectedFilePath(filePath)
              setFilteredDiffFiles([filePath])
              setIsDiffSidebarOpen(true)
            }}
            onOpenFile={setLinkedFileViewerPath}
            hideResizeHandle={
              !!fileViewerPath && fileViewerDisplayMode === "side-peek"
            }
          />
        )}
    </>
  )
}
