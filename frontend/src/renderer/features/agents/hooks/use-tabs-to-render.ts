import { useMemo } from "react"

interface UseTabsToRenderOptions {
  activeConversationId: string | null
  splitPaneIds: string[]
  pinnedConversationIds: string[]
  openConversationIds: string[]
  allConversations: Array<{ id: string }>
  agentConversations: Array<{ id: string }>
}

/**
 * Maximum number of conversation tabs to keep mounted in the DOM.
 *
 * This is a **soft cap** that applies only to *recent* (background) tabs.
 * The active tab, pinned tabs, and split-pane tabs are always mounted
 * regardless of this limit, since they represent explicit user intent or
 * concurrent work that must remain live.
 *
 * Tuning this value trades memory/render cost against how many background
 * conversations stay warm for fast switching.
 */
const MAX_MOUNTED_TABS = 3

export function useTabsToRender({
  activeConversationId,
  splitPaneIds,
  pinnedConversationIds,
  openConversationIds,
  allConversations,
  agentConversations,
}: UseTabsToRenderOptions) {
  // CRITICAL: Filter by workspace to prevent rendering conversations from other workspaces
  // Always render: active + pinned, then fill with recent up to limit
  //
  // NOTE: `allConversations` and `agentConversations` MUST be referentially stable
  // (e.g., memoized by the caller) — otherwise this `useMemo` recomputes every render,
  // defeating its purpose. Callers should wrap these arrays in `useMemo` or a stable selector.
  const tabsToRender = useMemo(() => {
    if (!activeConversationId) return []

    // Combine server data (agentConversations) with local store (allConversations) for validation.
    // This handles:
    // 1. Race condition where setChatId resets allConversations but activeConversationId loads from localStorage
    // 2. Optimistic updates when creating new conversations (new conversation is in allConversations but not in agentConversations yet)
    //
    // By combining both sources, we validate against all known conversations from both server and local state.
    const validConversationIds = new Set([
      ...agentConversations.map(sc => sc.id),
      ...allConversations.map(sc => sc.id),
    ])

    // If active conversation doesn't belong to this workspace → return []
    // This prevents rendering conversations from another workspace during race condition
    if (!validConversationIds.has(activeConversationId)) {
      return []
    }

    // Filter openConversationIds and pinnedConversationIds to only valid IDs for this workspace
    const validOpenIds = openConversationIds.filter(id => validConversationIds.has(id))
    const validPinnedIds = pinnedConversationIds.filter(id => validConversationIds.has(id))
    const validSplitPaneIds = splitPaneIds.filter(id => validConversationIds.has(id))

    // Start with active (must always be mounted)
    const mustRender = new Set([activeConversationId])

    // Split panes must always be mounted
    for (const id of validSplitPaneIds) {
      mustRender.add(id)
    }

    // Add pinned tabs (only valid ones)
    for (const id of validPinnedIds) {
      mustRender.add(id)
    }

    // If we have room, add recent tabs from openConversationIds (only valid ones)
    if (mustRender.size < MAX_MOUNTED_TABS) {
      const remaining = MAX_MOUNTED_TABS - mustRender.size
      const recentTabs = validOpenIds
        .filter(id => !mustRender.has(id))
        .slice(-remaining) // Take the most recent (end of array)

      for (const id of recentTabs) {
        mustRender.add(id)
      }
    }

    // Return tabs to render
    // Always include activeConversationId even if not in validOpenIds (handles race condition
    // where openConversationIds from localStorage doesn't include the active tab yet)
    const result = validOpenIds.filter(id => mustRender.has(id))
    if (!result.includes(activeConversationId)) {
      result.unshift(activeConversationId)
    }

    for (const id of validSplitPaneIds) {
      if (!result.includes(id)) {
        result.push(id)
      }
    }

    // Pinned tabs must always be mounted, even if they're not in validOpenIds.
    // This mirrors the fallback above for activeConversationId and splitPaneIds,
    // ensuring a pinned conversation that isn't in the "open" list is still rendered.
    for (const id of validPinnedIds) {
      if (!result.includes(id)) {
        result.push(id)
      }
    }

    return result
  }, [activeConversationId, splitPaneIds, pinnedConversationIds, openConversationIds, allConversations, agentConversations])

  return {
    tabsToRender,
  }
}
