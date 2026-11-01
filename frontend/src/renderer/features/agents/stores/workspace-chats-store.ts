import { create } from "zustand"
import { getWindowId } from "../../../contexts/WindowContext"

/**
 * WorkspaceChat represents a chat at the workspace level.
 * This is different from ConversationMeta which represents a conversation/tab within a chat.
 */
export interface WorkspaceChat {
  id: string                    // "chat_xxx_xxx_xxxx"
  name: string | null
  workspaceId: string
  worktreePath: string | null
  branch: string | null
  baseBranch: string | null
  prUrl: string | null
  prNumber: number | null
  collaborationMode: string
  createdAt: Date
  updatedAt: Date
  archivedAt: Date | null
  // Optional metadata
  conversationCount?: number    // Number of conversations under this chat
  lastActivity?: Date           // Last activity time
}

interface WorkspaceChatsStore {
  // State
  workspaceId: string | null
  chats: WorkspaceChat[]
  activeChatId: string | null           // Currently selected chat
  pinnedChatIds: string[]               // Pinned chats
  expandedChatIds: string[]             // Expanded chats (showing conversations)

  // Sorting and filtering
  sortBy: "updatedAt" | "createdAt" | "name"
  filterQuery: string

  // Actions
  setWorkspaceId: (workspaceId: string | null) => void
  setChats: (chats: WorkspaceChat[]) => void
  updateChat: (chatId: string, updates: Partial<WorkspaceChat>) => void
  addChat: (chat: WorkspaceChat) => void
  removeChat: (chatId: string) => void

  setActiveChat: (chatId: string | null) => void
  togglePinChat: (chatId: string) => void
  toggleExpandChat: (chatId: string) => void

  setSortBy: (sortBy: "updatedAt" | "createdAt" | "name") => void
  setFilterQuery: (query: string) => void

  archiveChat: (chatId: string) => void
  unarchiveChat: (chatId: string) => void

  reset: () => void
}

// localStorage helpers - store active chat, pinned chats, expanded chats, and sort preference
// Prefixed with windowId to isolate state per Electron window
const getStorageKey = (workspaceId: string, type: "active" | "pinned" | "expanded" | "sort") =>
  `${getWindowId()}:workspace-${type}-chats-${workspaceId}`

const saveToLS = (workspaceId: string, type: "active" | "pinned" | "expanded" | "sort", value: unknown) => {
  if (typeof window === "undefined") return
  localStorage.setItem(getStorageKey(workspaceId, type), JSON.stringify(value))
}

const loadFromLS = <T>(workspaceId: string, type: "active" | "pinned" | "expanded" | "sort", fallback: T): T => {
  if (typeof window === "undefined") return fallback
  try {
    const key = getStorageKey(workspaceId, type)
    const stored = localStorage.getItem(key)
    return stored ? JSON.parse(stored) : fallback
  } catch (e) {
    console.warn(`[WorkspaceChatsStore] Failed to load ${type}, using fallback:`, e)
    return fallback
  }
}

export const useWorkspaceChatsStore = create<WorkspaceChatsStore>((set, get) => ({
  workspaceId: null,
  chats: [],
  activeChatId: null,
  pinnedChatIds: [],
  expandedChatIds: [],
  sortBy: "updatedAt",
  filterQuery: "",

  setWorkspaceId: (workspaceId) => {
    if (!workspaceId) {
      set({
        workspaceId: null,
        chats: [],
        activeChatId: null,
        pinnedChatIds: [],
        expandedChatIds: [],
        sortBy: "updatedAt",
        filterQuery: "",
      })
      return
    }

    // Load from localStorage
    const activeChatId = loadFromLS<string | null>(workspaceId, "active", null)
    const pinnedChatIds = loadFromLS<string[]>(workspaceId, "pinned", [])
    const expandedChatIds = loadFromLS<string[]>(workspaceId, "expanded", [])
    const sortBy = loadFromLS<"updatedAt" | "createdAt" | "name">(workspaceId, "sort", "updatedAt")

    set({ workspaceId, activeChatId, pinnedChatIds, expandedChatIds, sortBy })
  },

  setChats: (chats) => {
    set({ chats })
  },

  updateChat: (chatId, updates) => {
    const { chats } = get()
    set({
      chats: chats.map((chat) =>
        chat.id === chatId ? { ...chat, ...updates } : chat
      ),
    })
  },

  addChat: (chat) => {
    const { chats } = get()
    if (chats.some((c) => c.id === chat.id)) return
    set({ chats: [...chats, chat] })
  },

  removeChat: (chatId) => {
    const { chats, activeChatId, pinnedChatIds, expandedChatIds, workspaceId } = get()
    const newChats = chats.filter((c) => c.id !== chatId)
    const newActiveChatId = activeChatId === chatId ? null : activeChatId
    const newPinnedIds = pinnedChatIds.filter((id) => id !== chatId)
    const newExpandedIds = expandedChatIds.filter((id) => id !== chatId)

    set({
      chats: newChats,
      activeChatId: newActiveChatId,
      pinnedChatIds: newPinnedIds,
      expandedChatIds: newExpandedIds,
    })

    // Clean up localStorage
    if (workspaceId) {
      if (newActiveChatId !== activeChatId) {
        saveToLS(workspaceId, "active", newActiveChatId)
      }
      if (newPinnedIds.length !== pinnedChatIds.length) {
        saveToLS(workspaceId, "pinned", newPinnedIds)
      }
      if (newExpandedIds.length !== expandedChatIds.length) {
        saveToLS(workspaceId, "expanded", newExpandedIds)
      }
    }
  },

  setActiveChat: (chatId) => {
    const { workspaceId } = get()
    set({ activeChatId: chatId })
    if (workspaceId && chatId) {
      saveToLS(workspaceId, "active", chatId)
    }
  },

  togglePinChat: (chatId) => {
    const { pinnedChatIds, workspaceId } = get()
    const newPinnedIds = pinnedChatIds.includes(chatId)
      ? pinnedChatIds.filter((id) => id !== chatId)
      : [...pinnedChatIds, chatId]

    set({ pinnedChatIds: newPinnedIds })
    if (workspaceId) {
      saveToLS(workspaceId, "pinned", newPinnedIds)
    }
  },

  toggleExpandChat: (chatId) => {
    const { expandedChatIds, workspaceId } = get()
    const newExpandedIds = expandedChatIds.includes(chatId)
      ? expandedChatIds.filter((id) => id !== chatId)
      : [...expandedChatIds, chatId]

    set({ expandedChatIds: newExpandedIds })
    if (workspaceId) {
      saveToLS(workspaceId, "expanded", newExpandedIds)
    }
  },

  setSortBy: (sortBy) => {
    const { workspaceId } = get()
    set({ sortBy })
    if (workspaceId) {
      saveToLS(workspaceId, "sort", sortBy)
    }
  },

  setFilterQuery: (query) => {
    set({ filterQuery: query })
  },

  archiveChat: (chatId) => {
    const { chats, activeChatId, workspaceId } = get()
    const newChats = chats.map((chat) =>
      chat.id === chatId
        ? { ...chat, archivedAt: new Date() }
        : chat
    )

    // If archiving the active chat, clear activeChatId
    const newActiveChatId = activeChatId === chatId ? null : activeChatId

    set({
      chats: newChats,
      activeChatId: newActiveChatId,
    })

    // Update localStorage if activeChatId changed
    if (workspaceId && newActiveChatId !== activeChatId) {
      saveToLS(workspaceId, "active", newActiveChatId)
    }
  },

  unarchiveChat: (chatId) => {
    const { chats } = get()
    set({
      chats: chats.map((chat) =>
        chat.id === chatId
          ? { ...chat, archivedAt: null }
          : chat
      ),
    })
  },

  reset: () => {
    set({
      workspaceId: null,
      chats: [],
      activeChatId: null,
      pinnedChatIds: [],
      expandedChatIds: [],
      sortBy: "updatedAt",
      filterQuery: "",
    })
  },
}))
