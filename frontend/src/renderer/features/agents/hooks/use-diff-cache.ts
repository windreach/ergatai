import { useCallback } from "react"

interface DiffCacheData {
  diffStats: {
    fileCount: number
    additions: number
    deletions: number
    isLoading: boolean
    hasChanges: boolean
  }
  parsedFileDiffs: any
  prefetchedFileContents: Record<string, string>
  diffContent: string | null
}

interface UseDiffCacheProps {
  setDiffCache: (updater: (prev: DiffCacheData) => DiffCacheData) => void
}

/**
 * Hook to provide smart setters for diff cache that prevent unnecessary re-renders
 */
export function useDiffCache({ setDiffCache }: UseDiffCacheProps) {
  const setDiffStats = useCallback((val: any) => {
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

  const setParsedFileDiffs = useCallback((files: any[] | null) => {
    setDiffCache((prev) => ({ ...prev, parsedFileDiffs: files as any }))
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
