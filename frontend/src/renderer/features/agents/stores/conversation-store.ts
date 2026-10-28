import { create } from "zustand"
import { useMessageQueueStore } from "./message-queue-store"
import { useStreamingStatusStore } from "./streaming-status-store"
import { agentChatStore } from "./agent-chat-store"
import { getWindowId } from "../../../contexts/WindowContext"
import { clearTaskSnapshotCache } from "../ui/agent-task-tools"
import { clearConversationRuntimeCaches } from "./conversation-runtime-cleanup"
import { getDefaultRatios, addPaneRatio, removePaneRatio } from "../atoms"

const MAX_SPLIT_PANES = 4

export interface ConversationMeta {
  id: string
  name: string
  created_at?: string
  updated_at?: string
  mode?: "plan" | "agent"
}

interface AgentConversationStore {
  // Current parent chat context
  chatId: string | null

  // State
  activeConversationId: string | null // Currently selected tab
  openConversationIds: string[] // Open tabs (preserves order)
  pinnedConversationIds: string[] // Pinned conversations
  allConversations: ConversationMeta[] // All conversations for history
  splitPaneIds: string[] // Ordered IDs of panes in split group (empty = no split)
  splitRatios: number[] // Per-pane width ratios summing to 1.0

  // Actions
  setChatId: (chatId: string | null) => void
  setActiveConversation: (conversationId: string) => void
  setOpenConversations: (conversationIds: string[]) => void
  addToOpenConversations: (conversationId: string) => void
  removeFromOpenConversations: (conversationId: string) => void
  togglePinConversation: (conversationId: string) => void
  setAllConversations: (conversations: ConversationMeta[]) => void
  addToAllConversations: (conversation?: ConversationMeta) => void
  updateConversationName: (conversationId: string, name: string) => void
  updateConversationMode: (conversationId: string, mode: "plan" | "agent") => void
  updateConversationTimestamp: (conversationId: string) => void
  addToSplit: (conversationId: string) => void
  removeFromSplit: (conversationId: string) => void
  closeSplit: () => void
  setSplitRatios: (ratios: number[]) => void
  initSplitFromWindow: (paneIds: string[]) => void
  reset: () => void
}

// localStorage helpers - store open tabs, active tab, and pinned tabs
// Prefixed with windowId to isolate state per Electron window
const getStorageKey = (chatId: string, type: "open" | "active" | "pinned" | "split" | "splitOrigin" | "splitPanes" | "splitRatios") =>
  `${getWindowId()}:agent-${type}-conversations-${chatId}`

const getLegacyStorageKey = (chatId: string, type: "open" | "active" | "pinned" | "split" | "splitOrigin" | "splitPanes" | "splitRatios") =>
  `agent-${type}-conversations-${chatId}`

// Custom event for notifying other components when open conversations change
export const OPEN_CONVERSATION_CHANGE_EVENT = "open-conversation-change"

// Debounce timer to avoid rapid-fire events
let openConversationsChangeTimer: ReturnType<typeof setTimeout> | null = null

const saveToLS = (chatId: string, type: "open" | "active" | "pinned" | "split" | "splitOrigin" | "splitPanes" | "splitRatios", value: unknown) => {
  if (typeof window === "undefined") return
  localStorage.setItem(getStorageKey(chatId, type), JSON.stringify(value))
  // Dispatch debounced event when open conversations change so sidebar can update
  if (type === "open") {
    if (openConversationsChangeTimer) clearTimeout(openConversationsChangeTimer)
    openConversationsChangeTimer = setTimeout(() => {
      window.dispatchEvent(new CustomEvent(OPEN_CONVERSATION_CHANGE_EVENT))
      openConversationsChangeTimer = null
    }, 50)
  }
}

// Find data from old numeric window IDs (e.g., "1:agent-open-conversations-xxx")
const findNumericWindowIdValue = (legacyKey: string, targetKey: string): string | null => {
  // Only migrate for "main" window
  if (!targetKey.startsWith("main:")) return null

  for (let i = 0; i < localStorage.length; i++) {
    const storageKey = localStorage.key(i)
    if (!storageKey) continue

    // Check if this key matches pattern: <number>:<legacyKey>
    const match = storageKey.match(/^(\d+):(.+)$/)
    if (match && match[2] === legacyKey) {
      const value = localStorage.getItem(storageKey)
      if (value !== null) {
        console.log(`[ConversationStore] Migrated from numeric ID: ${storageKey} to ${targetKey}`)
        return value
      }
    }
  }
  return null
}

const loadFromLS = <T>(chatId: string, type: "open" | "active" | "pinned" | "split" | "splitOrigin" | "splitPanes" | "splitRatios", fallback: T): T => {
  if (typeof window === "undefined") return fallback
  try {
    const key = getStorageKey(chatId, type)
    let stored = localStorage.getItem(key)

    // Migration 1: check for old numeric window ID keys
    if (stored === null) {
      const legacyKey = getLegacyStorageKey(chatId, type)
      const numericValue = findNumericWindowIdValue(legacyKey, key)
      if (numericValue !== null) {
        localStorage.setItem(key, numericValue)
        stored = numericValue
      }
    }

    // Migration 2: check legacy key if window-scoped key doesn't exist
    if (stored === null) {
      const legacyKey = getLegacyStorageKey(chatId, type)
      const legacyStored = localStorage.getItem(legacyKey)
      if (legacyStored !== null) {
        // Migrate to window-scoped key
        localStorage.setItem(key, legacyStored)
        stored = legacyStored
        console.log(`[ConversationStore] Migrated ${legacyKey} to ${key}`)
      }
    }

    return stored ? JSON.parse(stored) : fallback
  } catch (e) {
    console.warn(`[ConversationStore] Failed to load key=${getStorageKey(chatId, type)}, using fallback:`, e)
    return fallback
  }
}

export const useAgentConversationStore = create<AgentConversationStore>((set, get) => ({
  chatId: null,
  activeConversationId: null,
  openConversationIds: [],
  pinnedConversationIds: [],
  allConversations: [],
  splitPaneIds: [],
  splitRatios: [],

  setChatId: (chatId) => {
    if (!chatId) {
      set({
        chatId: null,
        activeConversationId: null,
        openConversationIds: [],
        pinnedConversationIds: [],
        allConversations: [],
        splitPaneIds: [],
        splitRatios: [],
      })
      return
    }

    // Load open/active/pinned IDs from localStorage
    // allConversations will be populated from DB + placeholders in init effect
    const openConversationIds = loadFromLS<string[]>(chatId, "open", [])
    const activeConversationId = loadFromLS<string | null>(chatId, "active", null)
    const pinnedConversationIds = loadFromLS<string[]>(chatId, "pinned", [])

    // Load split panes — migrate from old splitConversationId/splitOriginId if needed
    let splitPaneIds = loadFromLS<string[]>(chatId, "splitPanes", [])
    if (splitPaneIds.length === 0) {
      const oldSplit = loadFromLS<string | null>(chatId, "split", null)
      const oldOrigin = loadFromLS<string | null>(chatId, "splitOrigin", null)
      if (oldSplit && oldOrigin) {
        splitPaneIds = [oldOrigin, oldSplit]
        saveToLS(chatId, "splitPanes", splitPaneIds)
      }
    }

    // Validate splitPaneIds against openConversationIds and pane cap
    splitPaneIds = splitPaneIds
      .filter(id => openConversationIds.includes(id))
      .slice(0, MAX_SPLIT_PANES)
    if (splitPaneIds.length < 2) splitPaneIds = []

    // Load per-chat ratios, reset if length doesn't match pane count
    let splitRatios = loadFromLS<number[]>(chatId, "splitRatios", [])
    if (splitRatios.length !== splitPaneIds.length) {
      splitRatios = getDefaultRatios(splitPaneIds.length)
    }

    set({ chatId, openConversationIds, activeConversationId, pinnedConversationIds, splitPaneIds, splitRatios, allConversations: [] })
  },

  setActiveConversation: (conversationId) => {
    const { chatId } = get()
    // Split group is independent — navigating tabs never touches it.
    // Split view shows automatically when active tab is part of the group.
    set({ activeConversationId: conversationId })
    if (chatId) saveToLS(chatId, "active", conversationId)
  },

  setOpenConversations: (conversationIds) => {
    const { chatId } = get()
    set({ openConversationIds: conversationIds })
    if (chatId) saveToLS(chatId, "open", conversationIds)
  },

  addToOpenConversations: (conversationId) => {
    const { openConversationIds, chatId } = get()
    if (openConversationIds.includes(conversationId)) return
    const newIds = [...openConversationIds, conversationId]
    set({ openConversationIds: newIds })
    if (chatId) saveToLS(chatId, "open", newIds)
  },

  removeFromOpenConversations: (conversationId) => {
    const { openConversationIds, activeConversationId, chatId, splitPaneIds, splitRatios } = get()
    const newIds = openConversationIds.filter((id) => id !== conversationId)

    // If closing active tab, switch to last remaining tab
    let newActive = activeConversationId
    if (activeConversationId === conversationId) {
      newActive = newIds[newIds.length - 1] || null
    }

    // If closing a tab in the split group, remove it and update ratios
    let newSplitPaneIds = splitPaneIds
    let newRatios = splitRatios
    if (splitPaneIds.includes(conversationId)) {
      const removeIdx = splitPaneIds.indexOf(conversationId)
      newSplitPaneIds = splitPaneIds.filter((id) => id !== conversationId)
      newRatios = removePaneRatio(splitRatios, removeIdx)
      if (newSplitPaneIds.length < 2) { newSplitPaneIds = []; newRatios = [] }
    }

    set({ openConversationIds: newIds, activeConversationId: newActive, splitPaneIds: newSplitPaneIds, splitRatios: newRatios })
    if (chatId) {
      saveToLS(chatId, "open", newIds)
      saveToLS(chatId, "active", newActive)
      if (newSplitPaneIds !== splitPaneIds) {
        saveToLS(chatId, "splitPanes", newSplitPaneIds)
        saveToLS(chatId, "splitRatios", newRatios)
      }
    }

    // Cleanup queue, streaming status, Chat instance, and task snapshot cache
    // to prevent memory leaks and race conditions (QueueProcessor sending to closed conversation?)
    const cleanups = [
      () => useMessageQueueStore.getState().removeConversation(conversationId),
      () => useStreamingStatusStore.getState().clearStatus(conversationId),
      () => clearConversationRuntimeCaches(conversationId),
      () => agentChatStore.delete(conversationId),
      () => clearTaskSnapshotCache(conversationId),
    ]
    for (const cleanup of cleanups) {
      try { cleanup() } catch (e) { console.error('[ConversationStore] Cleanup failed:', e) }
    }
  },

  togglePinConversation: (conversationId) => {
    const { pinnedConversationIds, chatId } = get()
    const newPinnedIds = pinnedConversationIds.includes(conversationId)
      ? pinnedConversationIds.filter((id) => id !== conversationId)
      : [...pinnedConversationIds, conversationId]

    set({ pinnedConversationIds: newPinnedIds })
    if (chatId) saveToLS(chatId, "pinned", newPinnedIds)
  },

  setAllConversations: (conversations) => {
    set({ allConversations: conversations })
  },

  addToAllConversations: (conversation?: ConversationMeta) => {
    if (!conversation) return
    const { allConversations } = get()
    if (allConversations.some((sc) => sc.id === conversation.id)) return
    set({ allConversations: [...allConversations, conversation] })
    // No localStorage persistence - allConversations is rebuilt from DB + open IDs on init
  },

  updateConversationName: (conversationId, name) => {
    const { allConversations } = get()
    set({
      allConversations: allConversations.map((sc) =>
        sc.id === conversationId
          ? { ...sc, name }
          : sc,
      ),
    })
    // No localStorage modification - just update in-memory state (like Canvas)
  },

  updateConversationMode: (conversationId, mode) => {
    const { allConversations } = get()
    set({
      allConversations: allConversations.map((sc) =>
        sc.id === conversationId
          ? { ...sc, mode }
          : sc,
      ),
    })
  },

  updateConversationTimestamp: (conversationId: string) => {
    const { allConversations } = get()
    const newTimestamp = new Date().toISOString()

    set({
      allConversations: allConversations.map((sc) =>
        sc.id === conversationId
          ? { ...sc, updated_at: newTimestamp }
          : sc,
      ),
    })
  },

  addToSplit: (conversationId) => {
    const { chatId, activeConversationId, splitPaneIds, splitRatios, openConversationIds } = get()
    if (conversationId === activeConversationId) return
    if (splitPaneIds.includes(conversationId)) return

    let newPaneIds: string[]
    let newRatios: number[]
    if (splitPaneIds.length === 0) {
      // Start new split group: [active, new]
      if (!activeConversationId) return
      newPaneIds = [activeConversationId, conversationId]
      newRatios = getDefaultRatios(2)
    } else if (splitPaneIds.length < MAX_SPLIT_PANES) {
      newPaneIds = [...splitPaneIds, conversationId]
      newRatios = addPaneRatio(splitRatios.length === splitPaneIds.length ? splitRatios : getDefaultRatios(splitPaneIds.length))
    } else {
      return // Max split panes reached
    }

    // Ensure the new pane is in open tabs
    let newOpenIds = openConversationIds
    if (!openConversationIds.includes(conversationId)) {
      newOpenIds = [...openConversationIds, conversationId]
    }

    set({ splitPaneIds: newPaneIds, splitRatios: newRatios, openConversationIds: newOpenIds })
    if (chatId) {
      saveToLS(chatId, "splitPanes", newPaneIds)
      saveToLS(chatId, "splitRatios", newRatios)
      if (newOpenIds !== openConversationIds) saveToLS(chatId, "open", newOpenIds)
    }
  },

  removeFromSplit: (conversationId) => {
    const { chatId, splitPaneIds, splitRatios } = get()
    if (!splitPaneIds.includes(conversationId)) return

    const removeIdx = splitPaneIds.indexOf(conversationId)
    let newPaneIds = splitPaneIds.filter((id) => id !== conversationId)
    let newRatios = removePaneRatio(splitRatios, removeIdx)
    if (newPaneIds.length < 2) { newPaneIds = []; newRatios = [] }

    set({ splitPaneIds: newPaneIds, splitRatios: newRatios })
    if (chatId) {
      saveToLS(chatId, "splitPanes", newPaneIds)
      saveToLS(chatId, "splitRatios", newRatios)
    }
  },

  closeSplit: () => {
    const { chatId } = get()
    set({ splitPaneIds: [], splitRatios: [] })
    if (chatId) {
      saveToLS(chatId, "splitPanes", [])
      saveToLS(chatId, "splitRatios", [])
    }
  },

  setSplitRatios: (ratios) => {
    const { chatId } = get()
    set({ splitRatios: ratios })
    if (chatId) saveToLS(chatId, "splitRatios", ratios)
  },

  initSplitFromWindow: (paneIds) => {
    if (paneIds.length < 2) return
    const normalizedPaneIds = paneIds.slice(0, MAX_SPLIT_PANES)
    const { chatId, openConversationIds } = get()
    // Add all pane IDs to open tabs
    const newOpenIds = [...openConversationIds]
    for (const id of normalizedPaneIds) {
      if (!newOpenIds.includes(id)) newOpenIds.push(id)
    }
    const ratios = getDefaultRatios(normalizedPaneIds.length)
    set({
      openConversationIds: newOpenIds,
      activeConversationId: normalizedPaneIds[0],
      splitPaneIds: normalizedPaneIds,
      splitRatios: ratios,
    })
    if (chatId) {
      saveToLS(chatId, "open", newOpenIds)
      saveToLS(chatId, "active", normalizedPaneIds[0])
      saveToLS(chatId, "splitPanes", normalizedPaneIds)
      saveToLS(chatId, "splitRatios", ratios)
    }
  },

  reset: () => {
    set({
      chatId: null,
      activeConversationId: null,
      openConversationIds: [],
      pinnedConversationIds: [],
      allConversations: [],
      splitPaneIds: [],
      splitRatios: [],
    })
  },
}))
