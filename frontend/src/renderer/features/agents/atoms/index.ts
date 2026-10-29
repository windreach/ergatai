import { atom } from "jotai"
import { atomWithStorage } from "jotai/utils"
import { atomFamily } from "jotai/utils"
import { atomWithWindowStorage } from "../../../lib/window-storage"
import type { FileMentionOption } from "../mentions/agents-mentions-editor"
import type {
  AgentRegistration,
  CoreAgentId,
  CoreAgentOption,
} from "../lib/agent-contract-api"

// Agent mode type - extensible for future modes like "debug"
export type AgentMode = "agent" | "plan"
export type CollaborationMode = "supervisor" | "group"

// Ordered list of modes - Shift+Tab cycles through these
export const AGENT_MODES: AgentMode[] = ["agent", "plan"]

// Get next mode in cycle (for Shift+Tab toggle)
export function getNextMode(current: AgentMode): AgentMode {
  const idx = AGENT_MODES.indexOf(current)
  return AGENT_MODES[(idx + 1) % AGENT_MODES.length]
}

export const collaborationModeAtom = atomWithWindowStorage<CollaborationMode>(
  "agents:collaborationMode",
  "supervisor",
  { getOnInit: true },
)

export const registeredAgentsAtom = atomWithStorage<AgentRegistration[]>(
  "agents:registered-agents",
  [],
  undefined,
  { getOnInit: true },
)

export type ChatAgentLogo = {
  agentId: CoreAgentId
  name: string
  avatarUrl?: string
}

export const MAX_CHAT_AGENT_LOGOS = 3

export type ChatAgentLogosMap = Record<string, ChatAgentLogo[]>
type StoredChatAgentLogosMap = Record<string, ChatAgentLogo[] | ChatAgentLogo>
type ChatAgentLogosUpdate =
  | ChatAgentLogosMap
  | ((current: ChatAgentLogosMap) => ChatAgentLogosMap)

export function createChatAgentLogos(
  agentIds: CoreAgentId[],
  coreAgents: CoreAgentOption[],
  registeredAgents: AgentRegistration[],
  fallbackName?: string,
): ChatAgentLogo[] {
  return Array.from(new Set(agentIds)).map((agentId) => {
    const name = coreAgents.find((agent) => agent.id === agentId)?.name
      ?? fallbackName
      ?? agentId
    const normalizedName = name.toLowerCase()
    const registeredAgent = registeredAgents.find((agent) => (
      agent.runtimeId === agentId ||
      agent.id === agentId ||
      agent.name.toLowerCase() === normalizedName
    ))

    return {
      agentId,
      name,
      avatarUrl: registeredAgent?.avatarUrl,
    }
  })
}

export function areVisibleChatAgentLogosEqual(
  previousLogos: ChatAgentLogo[] | undefined,
  nextLogos: ChatAgentLogo[],
): boolean {
  const previous = previousLogos
    ?.slice(0, MAX_CHAT_AGENT_LOGOS)
    .map((logo) => `${logo.agentId}:${logo.avatarUrl ?? ""}`)
    .sort()
    .join("|") ?? ""
  const next = nextLogos
    .slice(0, MAX_CHAT_AGENT_LOGOS)
    .map((logo) => `${logo.agentId}:${logo.avatarUrl ?? ""}`)
    .sort()
    .join("|")

  return previous === next
}

const storedChatAgentLogosAtom = atomWithStorage<StoredChatAgentLogosMap>(
  "agents:chatAgentLogos",
  {},
  undefined,
  { getOnInit: true },
)

export const chatAgentLogosAtom = atom(
  (get) => {
    const storedValue = get(storedChatAgentLogosAtom)
    return Object.fromEntries(
      Object.entries(storedValue).map(([chatId, logos]) => [
        chatId,
        Array.isArray(logos) ? logos : [logos],
      ]),
    ) as ChatAgentLogosMap
  },
  (get, set, update: ChatAgentLogosUpdate) => {
    const current = normalizeChatAgentLogos(get(storedChatAgentLogosAtom))
    const next = typeof update === "function" ? update(current) : update
    if (next === current) return

    set(storedChatAgentLogosAtom, next)
  },
)

function normalizeChatAgentLogos(value: StoredChatAgentLogosMap) {
  return Object.fromEntries(
    Object.entries(value).map(([chatId, logos]) => [
      chatId,
      Array.isArray(logos) ? logos : [logos],
    ]),
  ) as ChatAgentLogosMap
}

export const workspaceCollaborationModesAtom = atomWithWindowStorage<
  Record<string, CollaborationMode>
>("agents:workspaceCollaborationModes", {}, { getOnInit: true })

// Selected agent chat ID - null means "new chat" view. Persist per window so a
// page reload restores the same chat without sharing selection across windows.
export const selectedAgentChatIdAtom = atomWithWindowStorage<
  string | null
>("agents:selectedChatId", null, { getOnInit: true })

// Selected workspace IDs are isolated by collaboration mode so switching modes
// never leaks one mode's active workspace into the other.
const selectedWorkspaceIdsByModeAtom = atomWithWindowStorage<
  Record<CollaborationMode, string | null>
>(
  "agents:selectedWorkspaceIdsByMode",
  { supervisor: null, group: null },
  { getOnInit: true },
)

export const selectedWorkspaceIdAtom = atom(
  (get) => {
    const mode = get(collaborationModeAtom)
    return get(selectedWorkspaceIdsByModeAtom)[mode] ?? null
  },
  (get, set, workspaceId: string | null) => {
    const mode = get(collaborationModeAtom)
    set(selectedWorkspaceIdsByModeAtom, (previous) => ({
      ...previous,
      [mode]: workspaceId,
    }))
  },
)

// Previous agent chat ID - used to navigate back after archiving current chat
// Not persisted - only tracks within current session
export const previousAgentChatIdAtom = atom<string | null>(null)

// Selected draft ID - when user clicks on a draft in sidebar, this is set
// NewChatForm uses this to restore the draft text
// Reset to null when "New Workspace" is clicked or chat is created
export const selectedDraftIdAtom = atom<string | null>(null)

// Show new chat form explicitly - true by default so new users see the form, not kanban
// Set to false when kanban is explicitly opened (via hotkey or button)
// Set to true when "New Workspace" is clicked
export const showNewChatFormAtom = atom<boolean>(false)

// When true, suppress auto-focus on chat input (e.g. during sidebar keyboard navigation)
export const suppressInputFocusAtom = atom<boolean>(false)

// Pending mention to insert into the editor from external components (e.g. MCP widget in sidebar)
// When set, active-chat picks it up, calls editorRef.insertMention(), and resets to null
export const pendingMentionAtom = atom<FileMentionOption | null>(null)

// Preview paths storage - stores all preview paths keyed by chatId
const previewPathsStorageAtom = atomWithStorage<Record<string, string>>(
  "agents:previewPaths",
  {},
  undefined,
  { getOnInit: true },
)

// atomFamily to get/set preview path per chatId
export const previewPathAtomFamily = atomFamily((conversationId: string) =>
  atom(
    (get) => get(previewPathsStorageAtom)[conversationId] ?? "/",
    (get, set, newPath: string) => {
      const current = get(previewPathsStorageAtom)
      set(previewPathsStorageAtom, { ...current, [conversationId]: newPath })
    },
  ),
)

// Preview viewport modes storage - stores viewport mode per chatId
const viewportModesStorageAtom = atomWithStorage<
  Record<string, "desktop" | "mobile">
>("agents:viewportModes", {}, undefined, { getOnInit: true })

// atomFamily to get/set viewport mode per chatId
export const viewportModeAtomFamily = atomFamily((conversationId: string) =>
  atom(
    (get) => get(viewportModesStorageAtom)[conversationId] ?? "desktop",
    (get, set, newMode: "desktop" | "mobile") => {
      const current = get(viewportModesStorageAtom)
      set(viewportModesStorageAtom, { ...current, [conversationId]: newMode })
    },
  ),
)

// Preview scales storage - stores scale per chatId
const previewScalesStorageAtom = atomWithStorage<Record<string, number>>(
  "agents:previewScales",
  {},
  undefined,
  { getOnInit: true },
)

// atomFamily to get/set preview scale per chatId
export const previewScaleAtomFamily = atomFamily((conversationId: string) =>
  atom(
    (get) => get(previewScalesStorageAtom)[conversationId] ?? 100,
    (get, set, newScale: number) => {
      const current = get(previewScalesStorageAtom)
      set(previewScalesStorageAtom, { ...current, [conversationId]: newScale })
    },
  ),
)

// Mobile device dimensions storage - stores device settings per chatId
type MobileDeviceSettings = {
  width: number
  height: number
  preset: string
}

const mobileDevicesStorageAtom = atomWithStorage<
  Record<string, MobileDeviceSettings>
>("agents:mobileDevices", {}, undefined, { getOnInit: true })

// atomFamily to get/set mobile device settings per chatId
export const mobileDeviceAtomFamily = atomFamily((conversationId: string) =>
  atom(
    (get) =>
      get(mobileDevicesStorageAtom)[conversationId] ?? {
        width: 393,
        height: 852,
        preset: "iPhone 16",
      },
    (get, set, newDevice: MobileDeviceSettings) => {
      const current = get(mobileDevicesStorageAtom)
      set(mobileDevicesStorageAtom, { ...current, [conversationId]: newDevice })
    },
  ),
)

// Loading conversations: Map<conversationId, parentChatId>
// Used to show loading indicators on tabs and sidebar
// Set when generation starts, cleared when onFinish fires
export const loadingConversationsAtom = atom<Map<string, string>>(new Map())

// Helper to set loading state
export const setLoading = (
  setter: (fn: (prev: Map<string, string>) => Map<string, string>) => void,
  conversationId: string,
  parentChatId: string,
) => {
  setter((prev) => {
    // Only create new Map if value actually changed
    // This prevents unnecessary re-renders
    if (prev.get(conversationId) === parentChatId) return prev
    const next = new Map(prev)
    next.set(conversationId, parentChatId)
    return next
  })
}

// Helper to clear loading state
export const clearLoading = (
  setter: (fn: (prev: Map<string, string>) => Map<string, string>) => void,
  conversationId: string,
) => {
  setter((prev) => {
    // Only create new Map if conversationId was actually in loading state
    // This prevents unnecessary re-renders when switching between non-loading conversations
    if (!prev.has(conversationId)) return prev
    const next = new Map(prev)
    next.delete(conversationId)
    return next
  })
}

// Persisted preferences for agents page
export type SavedRepo = {
  id: string
  name: string
  full_name: string
  sandbox_status?: "not_setup" | "in_progress" | "ready" | "error"
  installation_id?: string
  isPublicImport?: boolean
} | null

export const lastSelectedRepoAtom = atomWithStorage<SavedRepo>(
  "agents:lastSelectedRepo",
  null,
  undefined,
  { getOnInit: true },
)

// Selected local project (persisted)
export type SelectedWorkspace = {
  id: string
  name: string
  path: string
  gitRemoteUrl?: string | null
  gitProvider?: "github" | "gitlab" | "bitbucket" | null
  gitOwner?: string | null
  gitRepo?: string | null
} | null

// Migration: copy old localStorage key to new key for existing users
if (typeof window !== "undefined") {
  const oldKey = "agents:selectedProject"
  const newKey = "agents:selectedWorkspace"
  try {
    const oldValue = window.localStorage.getItem(oldKey)
    if (oldValue && !window.localStorage.getItem(newKey)) {
      window.localStorage.setItem(newKey, oldValue)
      window.localStorage.removeItem(oldKey)
    }
  } catch {
    // Ignore storage access errors (e.g., privacy mode)
  }
}

// Selected local project - uses window-scoped storage so each window can work with different projects
export const selectedWorkspaceAtom = atomWithWindowStorage<SelectedWorkspace>(
  "agents:selectedWorkspace",
  null,
  { getOnInit: true },
)

export const lastSelectedAgentIdAtom = atomWithStorage<string>(
  "agents:lastSelectedAgentId",
  "claude-code",
  undefined,
  { getOnInit: true },
)

export const lastSelectedModelIdAtom = atomWithStorage<string>(
  "agents:lastSelectedModelId",
  "opus",
  undefined,
  { getOnInit: true },
)

export const lastSelectedCodexModelIdAtom = atomWithStorage<string>(
  "agents:lastSelectedCodexModelId",
  "gpt-5.3-codex",
  undefined,
  { getOnInit: true },
)

export type CodexThinkingPreference = "low" | "medium" | "high" | "xhigh"

export const lastSelectedCodexThinkingAtom = atomWithStorage<CodexThinkingPreference>(
  "agents:lastSelectedCodexThinking",
  "high",
  undefined,
  { getOnInit: true },
)

// Storage for per-conversation? Claude model selection.
// Falls back to lastSelectedModelIdAtom when conversation has no explicit selection yet.
const conversationModelIdsStorageAtom = atomWithStorage<Record<string, string>>(
  "agents:conversationModelIds",
  {},
  undefined,
  { getOnInit: true },
)

export const conversationModelIdAtomFamily = atomFamily((conversationId: string) =>
  atom(
    (get) => {
      if (!conversationId) return get(lastSelectedModelIdAtom)
      return get(conversationModelIdsStorageAtom)[conversationId] ?? get(lastSelectedModelIdAtom)
    },
    (get, set, newModelId: string) => {
      if (!conversationId) {
        set(lastSelectedModelIdAtom, newModelId)
        return
      }
      const current = get(conversationModelIdsStorageAtom)
      if (current[conversationId] === newModelId) return
      set(conversationModelIdsStorageAtom, { ...current, [conversationId]: newModelId })
    },
  ),
)

// Storage for per-conversation? Codex model selection.
// Falls back to lastSelectedCodexModelIdAtom when conversation has no explicit selection yet.
const conversationCodexModelIdsStorageAtom = atomWithStorage<Record<string, string>>(
  "agents:conversationCodexModelIds",
  {},
  undefined,
  { getOnInit: true },
)

export const conversationCodexModelIdAtomFamily = atomFamily((conversationId: string) =>
  atom(
    (get) => {
      if (!conversationId) return get(lastSelectedCodexModelIdAtom)
      return (
        get(conversationCodexModelIdsStorageAtom)[conversationId] ??
        get(lastSelectedCodexModelIdAtom)
      )
    },
    (get, set, newModelId: string) => {
      if (!conversationId) {
        set(lastSelectedCodexModelIdAtom, newModelId)
        return
      }
      const current = get(conversationCodexModelIdsStorageAtom)
      if (current[conversationId] === newModelId) return
      set(conversationCodexModelIdsStorageAtom, { ...current, [conversationId]: newModelId })
    },
  ),
)

// Storage for per-conversation? Codex thinking level.
// Falls back to lastSelectedCodexThinkingAtom when conversation has no explicit selection yet.
const conversationCodexThinkingStorageAtom = atomWithStorage<
  Record<string, CodexThinkingPreference>
>(
  "agents:conversationCodexThinking",
  {},
  undefined,
  { getOnInit: true },
)

export const conversationCodexThinkingAtomFamily = atomFamily((conversationId: string) =>
  atom(
    (get) => {
      if (!conversationId) return get(lastSelectedCodexThinkingAtom)
      return (
        get(conversationCodexThinkingStorageAtom)[conversationId] ??
        get(lastSelectedCodexThinkingAtom)
      )
    },
    (get, set, newThinking: CodexThinkingPreference) => {
      if (!conversationId) {
        set(lastSelectedCodexThinkingAtom, newThinking)
        return
      }
      const current = get(conversationCodexThinkingStorageAtom)
      if (current[conversationId] === newThinking) return
      set(conversationCodexThinkingStorageAtom, { ...current, [conversationId]: newThinking })
    },
  ),
)

// Storage for all conversation modes (persisted per conversationId)
const conversationModesStorageAtom = atomWithStorage<Record<string, AgentMode>>(
  "agents:conversationModes",
  {},
  undefined,
  { getOnInit: true },
)

// atomFamily to get/set mode per conversationId
export const conversationModeAtomFamily = atomFamily((conversationId: string) =>
  atom(
    (get) => get(conversationModesStorageAtom)[conversationId] ?? "agent",
    (get, set, newMode: AgentMode) => {
      const current = get(conversationModesStorageAtom)
      set(conversationModesStorageAtom, { ...current, [conversationId]: newMode })
    },
  ),
)

// Model ID to full Claude model string mapping
export const MODEL_ID_MAP: Record<string, string> = {
  opus: "opus",
  sonnet: "sonnet",
  haiku: "haiku",
}

// Sidebar state - window-scoped so each window has independent sidebar visibility
export const agentsSidebarOpenAtom = atomWithWindowStorage<boolean>(
  "agents-sidebar-open",
  true,
  { getOnInit: true },
)

// Sidebar width with localStorage persistence
export const agentsSidebarWidthAtom = atomWithStorage<number>(
  "agents-sidebar-width",
  224,
  undefined,
  { getOnInit: true },
)

// Preview sidebar (right) width and open state
export const agentsPreviewSidebarWidthAtom = atomWithStorage<number>(
  "agents-preview-sidebar-width",
  500,
  undefined,
  { getOnInit: true },
)

// Preview sidebar open state - window-scoped
export const agentsPreviewSidebarOpenAtom = atomWithWindowStorage<boolean>(
  "agents-preview-sidebar-open",
  true,
  { getOnInit: true },
)

// Diff sidebar (right) width (global - same width for all chats)
export const agentsDiffSidebarWidthAtom = atomWithStorage<number>(
  "agents-diff-sidebar-width",
  800,
  undefined,
  { getOnInit: true },
)

// Changes panel (file list) width within the diff sidebar
export const agentsChangesPanelWidthAtom = atomWithStorage<number>(
  "agents-changes-panel-width",
  280,
  undefined,
  { getOnInit: true },
)

// Changes panel collapsed state in narrow view (collapsed by default)
export const agentsChangesPanelCollapsedAtom = atomWithStorage<boolean>(
  "agents-changes-panel-collapsed",
  true, // collapsed by default
  undefined,
  { getOnInit: true },
)

// Diff view display mode - sidebar (side peek), center dialog, or fullscreen
// Defined early because diffSidebarOpenAtomFamily depends on it
export type DiffViewDisplayMode = "side-peek" | "center-peek" | "full-page"

export const diffViewDisplayModeAtom = atomWithStorage<DiffViewDisplayMode>(
  "agents:diffViewDisplayMode",
  "center-peek", // default to dialog for new users
  undefined,
  { getOnInit: true },
)

// Diff sidebar open state storage - window-scoped, stores per chatId
const diffSidebarOpenStorageAtom = atomWithWindowStorage<Record<string, boolean>>(
  "agents:diffSidebarOpen",
  {},
  { getOnInit: true },
)

// Runtime open state - not persisted, used for dialog/fullscreen modes
const diffSidebarOpenRuntimeAtom = atom<Record<string, boolean>>({})

// atomFamily to get/set diff sidebar open state per chatId
// Only restores persisted state when display mode is "side-peek" (sidebar mode)
// For dialog/fullscreen modes, we use runtime state only (not auto-restored on page load)
export const diffSidebarOpenAtomFamily = atomFamily((chatId: string) =>
  atom(
    (get) => {
      const displayMode = get(diffViewDisplayModeAtom)
      const runtimeOpen = get(diffSidebarOpenRuntimeAtom)[chatId]

      // If we have a runtime value, use it (user explicitly opened/closed)
      if (runtimeOpen !== undefined) {
        return runtimeOpen
      }

      // For initial load: only restore persisted state for sidebar mode
      // Dialog and fullscreen should not auto-open on page load
      if (displayMode !== "side-peek") {
        return false
      }
      return get(diffSidebarOpenStorageAtom)[chatId] ?? false
    },
    (get, set, isOpen: boolean) => {
      // Always update runtime state
      const currentRuntime = get(diffSidebarOpenRuntimeAtom)
      set(diffSidebarOpenRuntimeAtom, { ...currentRuntime, [chatId]: isOpen })

      // Also persist for sidebar mode
      const current = get(diffSidebarOpenStorageAtom)
      set(diffSidebarOpenStorageAtom, { ...current, [chatId]: isOpen })
    },
  ),
)

// Legacy global atom - kept for backwards compatibility, maps to empty string key
// TODO: Remove after migration
export const agentsDiffSidebarOpenAtom = atomWithWindowStorage<boolean>(
  "agents-diff-sidebar-open",
  false,
  { getOnInit: true },
)

// Focused file path in diff sidebar (for scroll-to-file feature)
// Set by AgentEditTool on click, consumed by AgentDiffView
export const agentsFocusedDiffFileAtom = atom<string | null>(null)

// Collapsed state for diff files per chat - preserved across narrow/wide layout changes
// Map<fileKey, isCollapsed>
const diffFilesCollapsedStorageAtom = atom<Record<string, Record<string, boolean>>>({})

export const diffFilesCollapsedAtomFamily = atomFamily((chatId: string) =>
  atom(
    (get) => get(diffFilesCollapsedStorageAtom)[chatId] ?? {},
    (get, set, collapsed: Record<string, boolean>) => {
      const current = get(diffFilesCollapsedStorageAtom)
      set(diffFilesCollapsedStorageAtom, { ...current, [chatId]: collapsed })
    },
  ),
)

// Helpers for split view ratio management
export function getDefaultRatios(n: number): number[] {
  if (n <= 0) return []
  return Array(n).fill(1 / n) as number[]
}

export function addPaneRatio(ratios: number[]): number[] {
  const n = ratios.length + 1
  const scale = (n - 1) / n
  return [...ratios.map(r => r * scale), 1 / n]
}

export function removePaneRatio(ratios: number[], removeIdx: number): number[] {
  if (removeIdx < 0 || removeIdx >= ratios.length) return getDefaultRatios(ratios.length)
  const removed = ratios[removeIdx]!
  const rest = ratios.filter((_, i) => i !== removeIdx)
  if (rest.length === 0) return []
  const sum = rest.reduce((a, b) => a + b, 0)
  if (sum === 0) return getDefaultRatios(rest.length)
  const result = rest.map(r => r + (r / sum) * removed)
  // Normalize to prevent floating-point drift
  const total = result.reduce((a, b) => a + b, 0)
  return total > 0 ? result.map(r => r / total) : getDefaultRatios(rest.length)
}

// Conversations display mode - tabs (horizontal) or sidebar (vertical list)
// Window-scoped so each window can have its own layout preference
export const agentsConversationsSidebarModeAtom = atomWithWindowStorage<
  "tabs" | "sidebar"
>("agents-conversations-mode", "tabs", { getOnInit: true })

// Conversations sidebar width (left side of chat area)
export const agentsConversationsSidebarWidthAtom = atomWithStorage<number>(
  "agents-conversations-sidebar-width",
  200,
  undefined,
  { getOnInit: true },
)

// Track chats with unseen changes (finished streaming but user hasn't opened them)
// Updated by onFinish callback in Chat instances
export const agentsUnseenChangesAtom = atom<Set<string>>(new Set<string>())

// Current todos state per conversation
// Syncs the first (creation) todo tool with subsequent updates
// Map structure: { [conversationId]: TodoState }
interface TodoItem {
  content: string
  status: "pending" | "in_progress" | "completed"
  activeForm?: string
}

interface TodoState {
  todos: TodoItem[]
  creationToolCallId: string | null // ID of the tool call that created the todos
}

const allTodosStorageAtom = atom<Record<string, TodoState>>({})

// atomFamily to get/set todos per conversationId
export const currentTodosAtomFamily = atomFamily((conversationId: string) =>
  atom(
    (get) => get(allTodosStorageAtom)[conversationId] ?? { todos: [], creationToolCallId: null },
    (get, set, newState: TodoState) => {
      const current = get(allTodosStorageAtom)
      set(allTodosStorageAtom, { ...current, [conversationId]: newState })
    },
  ),
)

// Current task tools state per conversation (from TaskCreate/TaskUpdate/TaskList/TaskGet)
// Synced from AgentTaskToolsGroup component snapshot cache
export interface TaskToolItem {
  id: string
  subject: string
  description?: string
  activeForm?: string
  status: "pending" | "in_progress" | "completed"
}

interface TaskToolState {
  tasks: TaskToolItem[]
}

const allTaskToolsStorageAtom = atom<Record<string, TaskToolState>>({})

// atomFamily to get/set task tool state per conversationId
export const currentTaskToolsAtomFamily = atomFamily((conversationId: string) =>
  atom(
    (get) => get(allTaskToolsStorageAtom)[conversationId] ?? { tasks: [] },
    (get, set, newState: TaskToolState) => {
      const current = get(allTaskToolsStorageAtom)
      set(allTaskToolsStorageAtom, { ...current, [conversationId]: newState })
    },
  ),
)

// Track conversations with unseen changes (finished streaming but user hasn't viewed them)
// Updated by onFinish callback in Chat instances
export const agentsConversationUnseenChangesAtom = atom<Set<string>>(
  new Set<string>(),
)

// Archive popover open state
export const archivePopoverOpenAtom = atom<boolean>(false)

// Search query for archive
export const archiveSearchQueryAtom = atom<string>("")

// Repository filter for archive (null = all repositories)
export const archiveRepositoryFilterAtom = atom<string | null>(null)

// Track last used mode (plan/agent) per chat
// Map<chatId, "plan" | "agent">
export const lastChatModesAtom = atom<Map<string, "plan" | "agent">>(
  new Map<string, "plan" | "agent">(),
)

// Mobile view mode - chat (default, shows NewChatForm), chats list, preview, diff, or terminal
export type AgentsMobileViewMode = "chats" | "chat" | "preview" | "diff" | "terminal"
export const agentsMobileViewModeAtom = atom<AgentsMobileViewMode>("chat")

// Debug mode for testing first-time user experience
// Only works in development mode
export interface AgentsDebugMode {
  enabled: boolean
  simulateNoTeams: boolean // Simulate no teams available
  simulateNoRepos: boolean // Simulate no repositories connected
  simulateNoReadyRepos: boolean // Simulate only non-ready repos (in_progress/error)
  resetOnboarding: boolean // Reset onboarding dialog on next load
  bypassConnections: boolean // Allow going through onboarding steps even if already connected
  forceStep:
    | "workspace"
    | "profile"
    | "claude-code"
    | "github"
    | "discord"
    | null // Force a specific onboarding step
  simulateCompleted: boolean // Simulate onboarding as completed
}

export const agentsDebugModeAtom = atomWithStorage<AgentsDebugMode>(
  "agents:debugMode",
  {
    enabled: false,
    simulateNoTeams: false,
    simulateNoRepos: false,
    simulateNoReadyRepos: false,
    resetOnboarding: false,
    bypassConnections: false,
    forceStep: null,
    simulateCompleted: false,
  },
  undefined,
  { getOnInit: true },
)

// Changed files per conversation for tracking edits/writes
// Map<conversationId, FileChange[]>
export interface ConversationFileChange {
  filePath: string
  displayPath: string
  additions: number
  deletions: number
}

export const conversationFilesAtom = atom<Map<string, ConversationFileChange[]>>(
  new Map(),
)

// Mapping from conversationId to chatId (workspace ID) for aggregating stats
// Map<conversationId, chatId>
export const conversationToChatMapAtom = atom<Map<string, string>>(new Map())

// Filter files for diff sidebar (null = show all files)
// When set, AgentDiffView will only show files matching these paths
export const filteredDiffFilesAtom = atom<string[] | null>(null)

// Selected file path in diff sidebar (for highlighting in file list and showing in diff view)
// Using atom instead of useState to prevent re-renders of unrelated components
export const selectedDiffFilePathAtom = atom<string | null>(null)

// PR creation loading state - atom to allow ChatViewInner to reset it after sending message
export const isCreatingPrAtom = atom<boolean>(false)

// Filter by conversation ID for diff sidebar and changes panel (null = show all)
// When set by Review button, both diff view and file list filter to this conversation's files
export const filteredConversationIdAtom = atom<string | null>(null)

// Selected commit for viewing in diff view
// null = show working tree diff (current behavior)
// When set, diff view shows files from this commit instead of working tree
export type SelectedCommit = {
	hash: string
	shortHash: string
	message: string
	description?: string
	author?: string
	date?: Date
} | null
export const selectedCommitAtom = atom<SelectedCommit>(null)

// Active tab in diff sidebar (Changes/History)
// Exposed as atom so external components (e.g. git activity badges) can switch tabs
export const diffActiveTabAtom = atom<"changes" | "diff" | "history">("changes")

// Pending PR message to send to chat
// Set by ChatView when "Create PR" is clicked, consumed by ChatViewInner
export const pendingPrMessageAtom = atom<{ message: string; conversationId: string } | null>(null)

// Pending Review message to send to chat
// Set by ChatView when "Review" is clicked, consumed by ChatViewInner
export const pendingReviewMessageAtom = atom<{ message: string; conversationId: string } | null>(null)

// Pending merge conflict resolution message to send to chat
// Set when user clicks "Fix Conflicts" button, consumed by ChatViewInner
export const pendingConflictResolutionMessageAtom = atom<{ message: string; conversationId: string } | null>(null)

// Pending auth retry - stores failed message when auth-error occurs
// After successful OAuth flow, this triggers automatic retry of the message
export type PendingAuthRetryMessage = {
  conversationId: string  // Required: only retry in the correct chat
  provider: "claude-code" | "codex"
  prompt: string
  images?: Array<{
    base64Data: string
    mediaType: string
    filename?: string
  }>
  readyToRetry: boolean  // Only retry when this is true (set by modal on OAuth success)
}
export const pendingAuthRetryMessageAtom = atom<PendingAuthRetryMessage | null>(null)

// Pending chat history file to inject into a newly created conversation
// Set when user switches provider mid-chat, consumed by ChatInputArea on mount
export interface PendingChatHistory {
  conversationId: string
  file: {
    id: string
    filePath: string
    filename: string
    size: number
    preview: string
    createdAt: Date
    kind: "chatHistory"
  }
}
export const pendingChatHistoryAtom = atom<PendingChatHistory | null>(null)

// Work mode preference (local = work in project dir, worktree = create isolated worktree)
export type WorkMode = "local" | "worktree"
export const lastSelectedWorkModeAtom = atomWithStorage<WorkMode>(
  "agents:lastSelectedWorkMode",
  "worktree", // default to worktree for current behavior
  undefined,
  { getOnInit: true },
)

// Last selected branch per project (persisted)
// Maps projectId -> { name: string, type: "local" | "remote" }
// Custom storage with migration from old string format
const lastSelectedBranchesStorage = {
  getItem: (key: string, initialValue: Record<string, { name: string; type: "local" | "remote" }>) => {
    const storedValue = localStorage.getItem(key)
    if (!storedValue) return initialValue

    try {
      const parsed = JSON.parse(storedValue)

      // Migrate old format: Record<string, string> -> Record<string, { name, type }>
      const migrated: Record<string, { name: string; type: "local" | "remote" }> = {}
      for (const [projectId, value] of Object.entries(parsed)) {
        if (typeof value === "string") {
          // Old format: string branch name -> assume "local" type
          migrated[projectId] = { name: value, type: "local" }
        } else if (value && typeof value === "object" && "name" in value && "type" in value) {
          // New format: already migrated
          migrated[projectId] = value as { name: string; type: "local" | "remote" }
        }
      }

      // Save migrated data back to localStorage
      if (Object.keys(migrated).length > 0) {
        localStorage.setItem(key, JSON.stringify(migrated))
      }

      return migrated
    } catch {
      return initialValue
    }
  },
  setItem: (key: string, value: Record<string, { name: string; type: "local" | "remote" }>) => {
    localStorage.setItem(key, JSON.stringify(value))
  },
  removeItem: (key: string) => {
    localStorage.removeItem(key)
  },
}

export const lastSelectedBranchesAtom = atomWithStorage<
  Record<string, { name: string; type: "local" | "remote" }>
>(
  "agents:lastSelectedBranches",
  {},
  lastSelectedBranchesStorage,
  { getOnInit: true },
)

// Compacting status per conversation
// Set<conversationId> - conversation?s currently being compacted
export const compactingConversationsAtom = atom<Set<string>>(new Set<string>())

// Track IDs of chats/conversations created in this browser session (NOT persisted - resets on reload)
// Used to determine whether to show placeholder + typewriter effect
export const justCreatedIdsAtom = atom<Set<string>>(new Set<string>())

// Backend-owned initial prompt turns are dispatched while the chat view is
// mounting. Keep a short-lived UI handle so the user sees "Generating" before
// the first runtime SSE event arrives.
export type PendingInitialPrompt = {
  turnId: string
  conversationId: string
  chatId: string
  status: "pending" | "dispatching" | "running" | "completed" | "failed"
}

export const pendingInitialPromptAtomFamily = atomFamily(
  (conversationId: string) => atom<PendingInitialPrompt | null>(null),
)

// Pending user questions from AskUserQuestion tool
// Set when Claude requests user input, cleared when answered or skipped
export const QUESTIONS_SKIPPED_MESSAGE = "User skipped questions - proceed with defaults"
export const QUESTIONS_TIMED_OUT_MESSAGE = "Timed out"

export type PendingUserQuestion = {
  conversationId: string
  parentChatId: string
  toolUseId: string
  questions: Array<{
    question: string
    header: string
    options: Array<{ label: string; description: string }>
    multiSelect: boolean
  }>
}
// Map<conversationId, PendingUserQuestion> - supports multiple pending questions across workspaces
export const pendingUserQuestionsAtom = atom<Map<string, PendingUserQuestion>>(new Map())

// Legacy type alias for backwards compatibility
export type PendingUserQuestions = PendingUserQuestion

// Expired user questions - questions that timed out but should still be answerable
// When answered, responses are sent as normal user messages instead of tool approvals
// Map<conversationId, PendingUserQuestion>
export const expiredUserQuestionsAtom = atom<Map<string, PendingUserQuestion>>(new Map())

// Track conversations with pending plan approval (plan ready but not yet implemented)
// Map<conversationId, parentChatId> - allows filtering by workspace
export const pendingPlanApprovalsAtom = atom<Map<string, string>>(new Map())

// Pending "Build plan" trigger - set by ChatView sidebar, consumed by ChatViewInner
// Contains conversationId to approve, null when no pending approval
export const pendingBuildPlanConversationIdAtom = atom<string | null>(null)

// Store AskUserQuestion results by toolUseId for real-time updates
// Map<toolUseId, result>
export const askUserQuestionResultsAtom = atom<Map<string, unknown>>(new Map())

// Unified undo stack for workspace and conversation archivation
// Supports Cmd+Z to restore the last archived item (workspace or conversation)
export type UndoItem =
  | { type: "workspace"; chatId: string; timeoutId: ReturnType<typeof setTimeout>; isRemote?: boolean }
  | { type: "conversation"; conversationId: string; chatId: string; timeoutId: ReturnType<typeof setTimeout> }

export const undoStackAtom = atom<UndoItem[]>([])

// Viewed files state for diff review (GitHub-style "Viewed" checkbox)
// Tracks which files have been reviewed with content hash to detect changes
export type ViewedFileState = {
  viewed: boolean
  contentHash: string // Hash of diffText when marked as viewed
}

// Storage atom for viewed files per chat
// Structure: { [conversationId]: { [fileKey]: ViewedFileState } }
const viewedFilesStorageAtom = atomWithStorage<
  Record<string, Record<string, ViewedFileState>>
>(
  "agents:viewedFiles",
  {},
  undefined,
  { getOnInit: true },
)

// atomFamily to get/set viewed files per chatId
export const viewedFilesAtomFamily = atomFamily((conversationId: string) =>
  atom(
    (get) => get(viewedFilesStorageAtom)[conversationId] ?? {},
    (get, set, newState: Record<string, ViewedFileState>) => {
      const current = get(viewedFilesStorageAtom)
      set(viewedFilesStorageAtom, { ...current, [conversationId]: newState })
    },
  ),
)

// Open Locally dialog trigger - set to chatId to open dialog for that chat
export const openLocallyChatIdAtom = atom<string | null>(null)

// Plan sidebar state atoms

// Plan sidebar width (global, persisted)
export const agentsPlanSidebarWidthAtom = atomWithStorage<number>(
  "agents-plan-sidebar-width",
  500,
  undefined,
  { getOnInit: true },
)

// Plan sidebar open state storage - stores per conversationId (persisted)
// Uses window-scoped storage so each window can have independent plan sidebar states
const planSidebarOpenStorageAtom = atomWithWindowStorage<Record<string, boolean>>(
  "agents:planSidebarOpen",
  {},
  { getOnInit: true },
)

// atomFamily to get/set plan sidebar open state per conversationId
export const planSidebarOpenAtomFamily = atomFamily((conversationId: string) =>
  atom(
    (get) => get(planSidebarOpenStorageAtom)[conversationId] ?? false,
    (get, set, isOpen: boolean) => {
      const current = get(planSidebarOpenStorageAtom)
      set(planSidebarOpenStorageAtom, { ...current, [conversationId]: isOpen })
    },
  ),
)

// Current plan path storage - stores per conversationId (runtime only, not persisted)
const currentPlanPathStorageAtom = atom<Record<string, string | null>>({})

// atomFamily to get/set current plan path per conversationId
export const currentPlanPathAtomFamily = atomFamily((conversationId: string) =>
  atom(
    (get) => get(currentPlanPathStorageAtom)[conversationId] ?? null,
    (get, set, planPath: string | null) => {
      const current = get(currentPlanPathStorageAtom)
      set(currentPlanPathStorageAtom, { ...current, [conversationId]: planPath })
    },
  ),
)

// Per-chat plan edit refetch trigger - incremented when an Edit on a plan file completes
// Used to trigger sidebar refetch when plan content changes
const planEditRefetchTriggerStorageAtom = atom<Record<string, number>>({})

export const planEditRefetchTriggerAtomFamily = atomFamily((conversationId: string) =>
  atom(
    (get) => get(planEditRefetchTriggerStorageAtom)[conversationId] ?? 0,
    (get, set) => {
      const current = get(planEditRefetchTriggerStorageAtom)
      const currentValue = current[conversationId] ?? 0
      set(planEditRefetchTriggerStorageAtom, { ...current, [conversationId]: currentValue + 1 })
    },
  ),
)

// ============================================================================
// Diff Data Cache (per workspace) - prevents data loss when switching workspaces
// ============================================================================

// ParsedDiffFile type (same as in shared/changes-types.ts but avoiding import cycle)
export interface CachedParsedDiffFile {
  key: string
  oldPath: string
  newPath: string
  diffText: string
  isBinary: boolean
  additions: number
  deletions: number
  isValid: boolean
  fileLang: string | null
  isNewFile: boolean
  isDeletedFile: boolean
}

export interface DiffStatsCache {
  fileCount: number
  additions: number
  deletions: number
  isLoading: boolean
  hasChanges: boolean
}

export interface WorkspaceDiffCache {
  parsedFileDiffs: CachedParsedDiffFile[] | null
  diffStats: DiffStatsCache
  prefetchedFileContents: Record<string, string>
  diffContent: string | null
}

// Default stats for loading state
const DEFAULT_DIFF_STATS: DiffStatsCache = {
  fileCount: 0,
  additions: 0,
  deletions: 0,
  isLoading: true,
  hasChanges: false,
}

// Runtime cache for diff data per workspace (not persisted)
const workspaceDiffCacheStorageAtom = atom<Record<string, WorkspaceDiffCache>>({})

// Default cache value
const DEFAULT_DIFF_CACHE: WorkspaceDiffCache = {
  parsedFileDiffs: null,
  diffStats: DEFAULT_DIFF_STATS,
  prefetchedFileContents: {},
  diffContent: null,
}

export const workspaceDiffCacheAtomFamily = atomFamily((chatId: string) =>
  atom(
    (get) => get(workspaceDiffCacheStorageAtom)[chatId] ?? DEFAULT_DIFF_CACHE,
    (get, set, update: WorkspaceDiffCache | ((prev: WorkspaceDiffCache) => WorkspaceDiffCache)) => {
      const current = get(workspaceDiffCacheStorageAtom)
      const prevCache = current[chatId] ?? DEFAULT_DIFF_CACHE
      const newCache = typeof update === 'function' ? update(prevCache) : update
      set(workspaceDiffCacheStorageAtom, {
        ...current,
        [chatId]: newCache,
      })
    },
  ),
)

// Show raw JSON for each message in chat (dev only)
export const showMessageJsonAtom = atomWithStorage<boolean>(
  "agents:showMessageJson",
  false,
  undefined,
  { getOnInit: true },
)

// ============================================================================
// DESKTOP VIEW NAVIGATION
// ============================================================================

// Desktop view mode - takes priority over chat-based rendering
// null = default behavior (chat/new-chat/kanban)
export type DesktopView = "settings" | "task-board" | "add-agent" | null
export const desktopViewAtom = atom<DesktopView>(null)

// Settings inner sidebar widths (for Keyboard, Projects two-panel layouts)
// Non-persisted — resets to default on re-render
export const settingsKeyboardSidebarWidthAtom = atom(240)
export const settingsProjectsSidebarWidthAtom = atom(240)

// File viewer display mode - sidebar (side peek), center dialog, or fullscreen
export type FileViewerDisplayMode = "side-peek" | "center-peek" | "full-page"

export const fileViewerDisplayModeAtom = atomWithStorage<FileViewerDisplayMode>(
  "agents:fileViewerDisplayMode",
  "side-peek",
  undefined,
  { getOnInit: true },
)

// File viewer sidebar width (persisted)
export const fileViewerSidebarWidthAtom = atomWithStorage<number>(
  "agents:fileViewerSidebarWidth",
  500,
  undefined,
  { getOnInit: true },
)

// File viewer word wrap preference (persisted)
export const fileViewerWordWrapAtom = atomWithStorage<boolean>(
  "agents:fileViewerWordWrap",
  false,
  undefined,
  { getOnInit: true },
)

// File viewer minimap preference (persisted)
export const fileViewerMinimapAtom = atomWithStorage<boolean>(
  "agents:fileViewerMinimap",
  true,
  undefined,
  { getOnInit: true },
)

// File viewer line numbers preference (persisted)
export const fileViewerLineNumbersAtom = atomWithStorage<boolean>(
  "agents:fileViewerLineNumbers",
  true,
  undefined,
  { getOnInit: true },
)

// File viewer sticky scroll preference (persisted)
export const fileViewerStickyScrollAtom = atomWithStorage<boolean>(
  "agents:fileViewerStickyScroll",
  false,
  undefined,
  { getOnInit: true },
)

// File viewer render whitespace preference (persisted)
export type FileViewerWhitespace = "none" | "selection" | "all"
export const fileViewerWhitespaceAtom = atomWithStorage<FileViewerWhitespace>(
  "agents:fileViewerWhitespace",
  "selection",
  undefined,
  { getOnInit: true },
)

// File viewer bracket pair colorization preference (persisted)
export const fileViewerBracketPairsAtom = atomWithStorage<boolean>(
  "agents:fileViewerBracketPairs",
  true,
  undefined,
  { getOnInit: true },
)

// File search dialog open state (Cmd+P)
export const fileSearchDialogOpenAtom = atom<boolean>(false)

// File viewer open state - stores the currently open file path per chatId
const fileViewerOpenStorageAtom = atom<Record<string, string | null>>({})

// Recently opened files - ordered list (most recent first), max 50
const MAX_RECENT_FILES = 50
export const recentlyOpenedFilesAtom = atom<string[]>([])

export const fileViewerOpenAtomFamily = atomFamily((chatId: string) =>
  atom(
    (get) => get(fileViewerOpenStorageAtom)[chatId] ?? null,
    (get, set, filePath: string | null) => {
      const current = get(fileViewerOpenStorageAtom)
      set(fileViewerOpenStorageAtom, { ...current, [chatId]: filePath })
      // Track in recently opened files
      if (filePath) {
        const recent = get(recentlyOpenedFilesAtom)
        const filtered = recent.filter((p) => p !== filePath)
        set(
          recentlyOpenedFilesAtom,
          [filePath, ...filtered].slice(0, MAX_RECENT_FILES),
        )
      }
    },
  ),
)
