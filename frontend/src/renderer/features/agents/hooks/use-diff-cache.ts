import { useCallback } from "react"
import type { WorkspaceDiffCache, DiffStatsCache, CachedParsedDiffFile } from "../atoms"
import type { ParsedDiffFile } from "../ui/agent-diff-view"

interface UseDiffCacheProps {
  setDiffCache: (updater: (prev: WorkspaceDiffCache) => WorkspaceDiffCache) => void
}

/**
 * Hook to provide smart setters for diff cache that prevent unnecessary re-renders
 */
export function useDiffCache({ setDiffCache }: UseDiffCacheProps) {
  const setDiffStats = useCallback((val: DiffStatsCache | ((prev: DiffStatsCache) => DiffStatsCache)) => {
    setDiffCache((prev) => {
      const newVal = typeof val === 'function' ? val(prev.diffStats) : val
      // Only update if something changed
      if (
        prev.diffStats.fileCount === newVal.fileCount &&
        prev.diffStats.additions === newVal.additions &&
        prev.diffStats.deletions === newVal.deletions &&
        prev.diffStats.isLoading === newVal.isLoading &&
        prev.diffStats.hasChanges === newVal.hasChanges
      ) {
        return prev // Return same reference to prevent re-render
      }
      return { ...prev, diffStats: newVal }
    })
  }, [setDiffCache])

  const setParsedFileDiffs = useCallback((files: ParsedDiffFile[] | null) => {
    setDiffCache((prev) => ({ ...prev, parsedFileDiffs: files as CachedParsedDiffFile[] | null }))
  }, [setDiffCache])

  const setPrefetchedFileContents = useCallback((contents: Record<string, string>) => {
    setDiffCache((prev) => ({ ...prev, prefetchedFileContents: contents }))
  }, [setDiffCache])

  const setDiffContent = useCallback((content: string | null) => {
    setDiffCache((prev) => ({ ...prev, diffContent: content }))
  }, [setDiffCache])

  return {
    setDiffStats,
    setParsedFileDiffs,
    setPrefetchedFileContents,
    setDiffContent,
  }
}
