import { useEffect } from "react"
import type { GitChangesStatus } from "../../../../shared/changes-types"
import type { ParsedDiffFile } from "../ui/agent-diff-view"
import type { DiffStatsCache } from "../atoms"

interface UseGitStatusSyncProps {
  gitStatus: GitChangesStatus | null | undefined
  isGitStatusLoading: boolean
  parsedFileDiffs: ParsedDiffFile[] | null
  setParsedFileDiffs: (files: ParsedDiffFile[] | null) => void
  setPrefetchedFileContents: (contents: Record<string, string>) => void
  setDiffContent: (content: string | null) => void
  setDiffStats: (val: DiffStatsCache | ((prev: DiffStatsCache) => DiffStatsCache)) => void
}

/**
 * Hook to sync parsedFileDiffs with git status
 * Clears diff data when all files are committed (fixes stale files after external git commit)
 */
export function useGitStatusSync({
  gitStatus,
  isGitStatusLoading,
  parsedFileDiffs,
  setParsedFileDiffs,
  setPrefetchedFileContents,
  setDiffContent,
  setDiffStats,
}: UseGitStatusSyncProps) {
  useEffect(() => {
    if (!gitStatus || isGitStatusLoading) return

    // Check if git status shows no uncommitted changes
    const hasUncommittedChanges =
      (gitStatus.staged?.length ?? 0) > 0 ||
      (gitStatus.unstaged?.length ?? 0) > 0 ||
      (gitStatus.untracked?.length ?? 0) > 0

    // If git shows no changes but we still have parsedFileDiffs, clear them
    if (!hasUncommittedChanges && parsedFileDiffs && parsedFileDiffs.length > 0) {
      console.log('[active-chat] Git status empty but parsedFileDiffs has files, refreshing diff data')
      setParsedFileDiffs([])
      setPrefetchedFileContents({})
      setDiffContent(null)
      setDiffStats({
        fileCount: 0,
        additions: 0,
        deletions: 0,
        isLoading: false,
        hasChanges: false,
      })
    }
  }, [gitStatus, isGitStatusLoading, parsedFileDiffs, setParsedFileDiffs, setPrefetchedFileContents, setDiffContent, setDiffStats])
}
