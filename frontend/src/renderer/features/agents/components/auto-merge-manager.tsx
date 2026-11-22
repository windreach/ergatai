"use client"

import { useEffect, useRef } from "react"
import { trpc } from "../../../lib/trpc"
import { useStreamingStatusStore } from "../stores/streaming-status-store"
import { useMessageQueueStore } from "../stores/message-queue-store"

type SyncCandidate = {
  id: string
  archivedAt?: Date | null
  branch?: string | null
  baseBranch?: string | null
  worktreePath?: string | null
}

type ProjectPathCacheEntry = {
  projectPath: string
  expiresAt: number
}

type AutoMergeConfigCacheEntry = {
  enabled: boolean
  expiresAt: number
}

const SCAN_INTERVAL_MS = 30_000
// Worktree -> project path is stable for the lifetime of a worktree; config can
// change from the settings UI, so keep it short enough to pick up edits.
const PROJECT_PATH_TTL_MS = 10 * 60_000
const AUTO_MERGE_CONFIG_TTL_MS = 60_000
const MAX_CONCURRENT_CHATS = 3

async function forEachWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0
  const workerCount = Math.min(limit, items.length)

  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex++
      if (index >= items.length) return
      // react-doctor-disable-next-line async-await-in-loop -- bounded worker pool: each worker awaits one task at a time by design
      await fn(items[index])
    }
  })

  await Promise.all(workers)
}

export function AutoMergeManager() {
  const chatsQuery = trpc.chats.list.useQuery({}, { staleTime: 30_000 })
  const utils = trpc.useUtils()

  // Keep the latest list in a ref so a background list refresh does not restart
  // the whole scan (the old effect depended on chatsQuery.data and re-ran the
  // N-chat scan immediately on every update).
  const chatsRef = useRef(chatsQuery.data)
  useEffect(() => {
    chatsRef.current = chatsQuery.data
  }, [chatsQuery.data])

  const runningRef = useRef(false)
  const runRef = useRef<() => void>(() => {})
  const hasRunInitialScanRef = useRef(false)
  const projectPathCacheRef = useRef(new Map<string, ProjectPathCacheEntry>())
  const configCacheRef = useRef(new Map<string, AutoMergeConfigCacheEntry>())
  // Deduplicate concurrent lookups for the same worktree/project. Without
  // this, the first scan fans out 3 workers and each chat in the same project
  // would independently shell out for the same config.
  const projectPathLoadsRef = useRef(new Map<string, Promise<string>>())
  const configLoadsRef = useRef(new Map<string, Promise<boolean>>())

  useEffect(() => {
    let cancelled = false

    const getProjectPath = async (worktreePath: string): Promise<string> => {
      const now = Date.now()
      const cached = projectPathCacheRef.current.get(worktreePath)
      if (cached && cached.expiresAt > now) return cached.projectPath

      const inFlight = projectPathLoadsRef.current.get(worktreePath)
      if (inFlight) return inFlight

      const load = (async () => {
        const { projectPath } = await utils.changes.resolveProjectPath.fetch({
          worktreePath,
        })
        projectPathCacheRef.current.set(worktreePath, {
          projectPath,
          expiresAt: now + PROJECT_PATH_TTL_MS,
        })
        return projectPath
      })().finally(() => {
        projectPathLoadsRef.current.delete(worktreePath)
      })

      projectPathLoadsRef.current.set(worktreePath, load)
      return load
    }

    const isAutoMergeEnabled = async (worktreePath: string): Promise<boolean> => {
      const projectPath = await getProjectPath(worktreePath)
      const now = Date.now()
      const cached = configCacheRef.current.get(projectPath)
      if (cached && cached.expiresAt > now) return cached.enabled

      const inFlight = configLoadsRef.current.get(projectPath)
      if (inFlight) return inFlight

      const load = (async () => {
        const cfg = await utils.worktreeConfig.getByPath.fetch({ projectPath })
        const enabled = cfg.config?.["auto-merge"] === true
        configCacheRef.current.set(projectPath, {
          enabled,
          expiresAt: now + AUTO_MERGE_CONFIG_TTL_MS,
        })
        return enabled
      })().finally(() => {
        configLoadsRef.current.delete(projectPath)
      })

      configLoadsRef.current.set(projectPath, load)
      return load
    }

    const syncChat = async (chat: SyncCandidate): Promise<void> => {
      if (
        cancelled ||
        !chat.branch ||
        !chat.baseBranch ||
        !chat.worktreePath ||
        // A chat whose branch is the same as its base branch has no distinct
        // branch delta to propagate; auto-syncing it only races with the user's
        // own edits on that branch and produces spurious base_dirty conflicts.
        chat.branch === chat.baseBranch
      ) {
        return
      }

      // Resolve project + config once per project before touching the heavier
      // per-chat agent/chat queries. Chats whose project has auto-merge off
      // cost at most one cached config lookup.
      const enabled = await isAutoMergeEnabled(chat.worktreePath)
      if (!enabled || cancelled) return

      const agentsResp = await utils.ergatai.getChatAgents.fetch({
        chatId: chat.id,
      })
      // `all_idle` is vacuously true for a chat with no agents (and the API
      // fails open to an empty list). Requiring at least one binding avoids
      // syncing a chat before any agent has ever run.
      const agents = agentsResp.agents ?? []
      if (
        cancelled ||
        agents.length === 0 ||
        !agentsResp.all_idle
      ) {
        return
      }

      const fullChat = await utils.chats.get.fetch({ id: chat.id })
      if (cancelled) return

      const conversations = (fullChat?.conversations ?? []) as Array<{
        id: string
      }>
      for (const conv of conversations) {
        if (useStreamingStatusStore.getState().isStreaming(conv.id)) return
        if ((useMessageQueueStore.getState().queues[conv.id]?.length ?? 0) > 0) {
          return
        }
      }

      // Sync the worktree's current files into the base checkout without
      // creating commits. Branches cannot represent uncommitted edits, so a
      // regular `git merge` would be a no-op for typical agent work.
      const result = await utils.client.changes.syncWorktreeToBase.mutate({
        worktreePath: chat.worktreePath,
        chatBranch: chat.branch,
        baseBranch: chat.baseBranch,
      })

      if (result.status === "synced") {
        console.info(
          `[AutoMerge] Synced ${result.filesChanged ?? 0} file(s) from ${chat.branch} into ${chat.baseBranch} working tree`,
        )
      } else if (result.status === "needs_manual_merge") {
        console.warn(
          `[AutoMerge] Could not sync ${chat.branch} into ${chat.baseBranch}:`,
          result.reason,
          result.conflictedFiles,
        )
      }
    }

    const run = async () => {
      if (runningRef.current) return

      const chats = (chatsRef.current ?? []) as SyncCandidate[]
      if (chats.length === 0) return

      runningRef.current = true
      try {
        const candidates = chats.filter(
          (chat) =>
            !chat.archivedAt &&
            !!chat.branch &&
            !!chat.baseBranch &&
            !!chat.worktreePath &&
            chat.branch !== chat.baseBranch,
        )

        // Bound concurrency: worktree config resolution shells out to git, and
        // syncs are already serialized per-project by the backend git lock.
        await forEachWithConcurrency(
          candidates,
          MAX_CONCURRENT_CHATS,
          async (chat) => {
            if (cancelled) return
            try {
              await syncChat(chat)
            } catch {
              // Best-effort: a single bad worktree must not abort the scan.
            }
          },
        )
      } finally {
        runningRef.current = false
      }
    }

    runRef.current = () => {
      void run()
    }

    // The first scan is triggered once when the list first becomes available
    // (see below); the interval only handles subsequent periodic scans.
    const interval = setInterval(() => {
      if (!cancelled) void run()
    }, SCAN_INTERVAL_MS)

    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [utils])

  // Run once as soon as the chat list is available. Later list refreshes only
  // update the ref; they do not restart the scan.
  useEffect(() => {
    if (hasRunInitialScanRef.current || !chatsQuery.data) return
    hasRunInitialScanRef.current = true
    runRef.current()
  }, [chatsQuery.data])

  return null
}
