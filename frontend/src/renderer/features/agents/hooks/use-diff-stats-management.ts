import { useCallback, useEffect, useRef } from "react"
import { trpcClient } from "../../../lib/trpc"

interface UseDiffStatsManagementOptions {
  worktreePath: string | null
  chatId: string | null
  isDiffSidebarOpen: boolean
  setParsedFileDiffs: (files: any[] | null) => void
  setPrefetchedFileContents: (contents: Record<string, string>) => void
  setDiffContent: (content: string | null) => void
  setDiffStats: (updater: (prev: any) => any) => void
}

export function useDiffStatsManagement({
  worktreePath,
  chatId,
  isDiffSidebarOpen,
  setParsedFileDiffs,
  setPrefetchedFileContents,
  setDiffContent,
  setDiffStats,
}: UseDiffStatsManagementOptions) {
  const fetchDiffStatsDebounceRef = useRef<NodeJS.Timeout | null>(null)
  const isFetchingDiffRef = useRef(false)

  const fetchDiffStats = useCallback(async () => {
    // Desktop uses worktreePath, web uses sandboxId
    // Don't reset stats if worktreePath is temporarily undefined - just skip the fetch
    // This prevents the button from becoming disabled when component re-renders
    if (!worktreePath) {
      return
    }

    // Prevent duplicate parallel fetches
    if (isFetchingDiffRef.current) {
      return
    }
    isFetchingDiffRef.current = true

    try {
      // Desktop: use new getParsedDiff endpoint (all-in-one: parsing + file contents)
      if (worktreePath && chatId) {
        const result = await trpcClient.chats.getParsedDiff.query({ chatId })

        if (result.files.length > 0) {
          // Store parsed files directly (already parsed on server)
          setParsedFileDiffs(result.files)

          // Store prefetched file contents
          setPrefetchedFileContents(result.fileContents)

          // Set diff content to null since we have parsed files
          // (AgentDiffView will use parsedFileDiffs when available)
          setDiffContent(null)

          setDiffStats(() => ({
            fileCount: result.files.length,
            additions: result.totalAdditions,
            deletions: result.totalDeletions,
            isLoading: false,
            hasChanges: result.files.length > 0,
          }))
        } else {
          setDiffStats(() => ({
            fileCount: 0,
            additions: 0,
            deletions: 0,
            isLoading: false,
            hasChanges: false,
          }))
          // Use empty array instead of null to signal "no changes" vs "still loading"
          setParsedFileDiffs([])
          setPrefetchedFileContents({})
          setDiffContent(null)
        }
        return
      }

      // Desktop without chat (viewing main repo directly)
      if (worktreePath && !chatId) {
        // TODO: Need to add endpoint that accepts worktreePath directly
        return
      }

    } catch (error) {
      console.error("[fetchDiffStats] Error:", error)
      setDiffStats((prev: { isLoading: boolean; hasChanges: boolean; fileCount: number; additions: number; deletions: number }) => ({ ...prev, isLoading: false }))
    } finally {
      isFetchingDiffRef.current = false
    }
  }, [worktreePath, chatId, setParsedFileDiffs, setPrefetchedFileContents, setDiffContent, setDiffStats])

  // Debounced version for calling after stream ends
  const fetchDiffStatsDebounced = useCallback(() => {
    if (fetchDiffStatsDebounceRef.current) {
      clearTimeout(fetchDiffStatsDebounceRef.current)
    }
    fetchDiffStatsDebounceRef.current = setTimeout(() => {
      fetchDiffStats()
    }, 2000) // 2s debounce to avoid spamming if multiple streams end
  }, [fetchDiffStats])

  // Ref to hold the latest fetchDiffStatsDebounced for use in onFinish callbacks
  const fetchDiffStatsRef = useRef(fetchDiffStatsDebounced)
  useEffect(() => {
    fetchDiffStatsRef.current = fetchDiffStatsDebounced
  }, [fetchDiffStatsDebounced])

  // Fetch diff stats on mount and when worktreePath/sandboxId changes
  useEffect(() => {
    fetchDiffStats()
  }, [fetchDiffStats])

  // Refresh diff stats when diff sidebar opens (background refresh - don't block UI)
  // Keep existing data visible while fetching, only update if data changed
  useEffect(() => {
    if (isDiffSidebarOpen) {
      // Fetch in background - existing parsedFileDiffs will be shown immediately
      fetchDiffStats()
    }
  }, [isDiffSidebarOpen, fetchDiffStats])

  // Throttled diff refresh for filesystem events (file edits, git ops)
  // Initialize to Date.now() to prevent double-fetch on mount
  // (the "mount" effect already fetches, throttle should wait)
  const lastDiffFetchTimeRef = useRef<number>(Date.now())
  const DIFF_THROTTLE_MS = 2000 // Max 1 fetch per 2 seconds
  const diffRefreshTimerRef = useRef<NodeJS.Timeout | null>(null)

  const scheduleDiffRefresh = useCallback(() => {
    const now = Date.now()
    const timeSinceLastFetch = now - lastDiffFetchTimeRef.current

    if (timeSinceLastFetch >= DIFF_THROTTLE_MS) {
      lastDiffFetchTimeRef.current = now
      fetchDiffStats()
      return
    }

    const delay = DIFF_THROTTLE_MS - timeSinceLastFetch
    if (diffRefreshTimerRef.current) {
      clearTimeout(diffRefreshTimerRef.current)
    }
    diffRefreshTimerRef.current = setTimeout(() => {
      diffRefreshTimerRef.current = null
      lastDiffFetchTimeRef.current = Date.now()
      fetchDiffStats()
    }, delay)
  }, [fetchDiffStats])

  useEffect(() => {
    return () => {
      if (diffRefreshTimerRef.current) {
        clearTimeout(diffRefreshTimerRef.current)
        diffRefreshTimerRef.current = null
      }
    }
  }, [])

  return {
    fetchDiffStats,
    fetchDiffStatsDebounced,
    fetchDiffStatsRef,
    scheduleDiffRefresh,
  }
}
