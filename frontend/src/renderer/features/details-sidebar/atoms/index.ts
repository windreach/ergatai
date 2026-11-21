import { atom } from "jotai"
import { atomWithStorage } from "jotai/utils"
import { atomFamily } from "jotai/utils"
import { atomWithWindowStorage } from "../../../lib/window-storage"
import type { LucideIcon } from "lucide-react"
import { FileText, Terminal, FileDiff, ListTodo, Users } from "lucide-react"
// import { OriginalMCPIcon } from "../../../components/ui/icons" // 暂时隐藏 MCP widget

// ============================================================================
// Widget System Types & Registry
// ============================================================================

export type WidgetId = "agents" | "todo" | "plan" | "terminal" | "diff" | "mcp"

export interface WidgetConfig {
  id: WidgetId
  label: string
  icon: LucideIcon
  canExpand: boolean // true = can open as separate sidebar
  defaultVisible: boolean
}

export const WIDGET_REGISTRY: WidgetConfig[] = [
  { id: "agents", label: "Agents", icon: Users, canExpand: false, defaultVisible: true },
  { id: "todo", label: "To-dos", icon: ListTodo, canExpand: false, defaultVisible: true },
  { id: "terminal", label: "Terminal", icon: Terminal, canExpand: true, defaultVisible: true },
  { id: "plan", label: "Plan", icon: FileText, canExpand: true, defaultVisible: false },
  { id: "diff", label: "Changes", icon: FileDiff, canExpand: true, defaultVisible: false },
  // 暂时隐藏 MCP widget：当前 discovery 只扫描静态配置文件 + registry，
  // 不包含运行时注入的 MCP（如 Ergatai MCP Tools），展示不完整。
  // { id: "mcp", label: "MCP Servers", icon: OriginalMCPIcon as unknown as LucideIcon, canExpand: false, defaultVisible: false },
]

// Helper to get default visible widgets
const DEFAULT_VISIBLE_WIDGETS: WidgetId[] = WIDGET_REGISTRY
  .filter((w) => w.defaultVisible)
  .map((w) => w.id)

// Default widget order (all widgets)
const DEFAULT_WIDGET_ORDER: WidgetId[] = WIDGET_REGISTRY.map((w) => w.id)

// ============================================================================
// Widget Visibility (per workspace)
// ============================================================================

const widgetVisibilityStorageAtom = atomWithStorage<Record<string, WidgetId[]>>(
  "overview:widgetVisibility",
  {},
  undefined,
  { getOnInit: true },
)

export const widgetVisibilityAtomFamily = atomFamily((workspaceId: string) =>
  atom(
    (get) =>
      get(widgetVisibilityStorageAtom)[workspaceId] ?? DEFAULT_VISIBLE_WIDGETS,
    (get, set, visibleWidgets: WidgetId[]) => {
      const current = get(widgetVisibilityStorageAtom)
      set(widgetVisibilityStorageAtom, {
        ...current,
        [workspaceId]: visibleWidgets,
      })
    },
  ),
)

// ============================================================================
// Widget Order (per workspace) - controls display order of all widgets
// ============================================================================

const widgetOrderStorageAtom = atomWithStorage<Record<string, WidgetId[]>>(
  "overview:widgetOrder",
  {},
  undefined,
  { getOnInit: true },
)

export const widgetOrderAtomFamily = atomFamily((workspaceId: string) =>
  atom(
    (get) =>
      get(widgetOrderStorageAtom)[workspaceId] ?? DEFAULT_WIDGET_ORDER,
    (get, set, widgetOrder: WidgetId[]) => {
      const current = get(widgetOrderStorageAtom)
      set(widgetOrderStorageAtom, {
        ...current,
        [workspaceId]: widgetOrder,
      })
    },
  ),
)

// ============================================================================
// Feature Flag & Sidebar State
// ============================================================================

// Feature flag for unified vs separate sidebars (for future toggle)
export const unifiedSidebarEnabledAtom = atomWithStorage<boolean>(
  "overview:unifiedEnabled",
  true, // Enable by default
  undefined,
  { getOnInit: true },
)

// Details sidebar open state (per-window, persisted)
export const detailsSidebarOpenAtom = atomWithWindowStorage<boolean>(
  "overview:sidebarOpen",
  false,
  { getOnInit: true },
)

// Details sidebar active tab (per-window, persisted).
// Note: the side chat used to be a tab here; it now lives in its own
// independent SideChatSidebar. A stale persisted "chat" value is treated
// as "details" by the sidebar.
export type DetailsSidebarTab = "details" | "files" | "git"

export const detailsSidebarTabAtom = atomWithWindowStorage<DetailsSidebarTab>(
  "overview:sidebarTab",
  "details",
  { getOnInit: true },
)

// Side chat sidebar open state (per-window, session-only) - independent
// sidebar coexisting with the details sidebar.
//
// This must NOT be persisted: the selected side chat (agent + conversation)
// lives in component state and is intentionally not restored on reload. If we
// restored the open flag alone, a restart/hot reload would show an empty
// "Chat" pane with no active agent ("Click an agent in the rail...") instead
// of the previously open conversation.
export const sideChatSidebarOpenAtom = atom<boolean>(false)

// Unified sidebar width (persisted)
export const detailsSidebarWidthAtom = atomWithStorage<number>(
  "overview:sidebarWidth",
  500,
  undefined,
  { getOnInit: true },
)

// Side chat sidebar width (persisted)
export const sideChatSidebarWidthAtom = atomWithStorage<number>(
  "overview:sideChatWidth",
  380,
  undefined,
  { getOnInit: true },
)

// ============================================================================
// Plan Content Cache (per workspace) - prevents flashing loading states
// ============================================================================

export interface PlanContentCache {
  content: string
  planPath: string
  // Track if content is ready (file loaded successfully)
  isReady: boolean
}

// Runtime cache for plan content per workspace (not persisted)
const planContentCacheStorageAtom = atom<Record<string, PlanContentCache | null>>({})

export const planContentCacheAtomFamily = atomFamily((chatId: string) =>
  atom(
    (get) => get(planContentCacheStorageAtom)[chatId] ?? null,
    (get, set, cache: PlanContentCache | null) => {
      const current = get(planContentCacheStorageAtom)
      set(planContentCacheStorageAtom, {
        ...current,
        [chatId]: cache,
      })
    },
  ),
)

// ============================================================================
// File Tree Expanded Paths (per worktree, persisted across reloads)
// ============================================================================

const fileTreeExpandedStorageAtom = atomWithStorage<
  Record<string, string[]>
>("overview:fileTreeExpanded", {}, undefined, { getOnInit: true })

/** null sentinel: first mount for this worktree (no user action yet → auto-expand roots) */
export const fileTreeExpandedAtomFamily = atomFamily((worktreePath: string) =>
  atom(
    (get): string[] | null => {
      const stored = get(fileTreeExpandedStorageAtom)[worktreePath]
      return stored ?? null // null = never initialised
    },
    (get, set, paths: string[]) => {
      const current = get(fileTreeExpandedStorageAtom)
      set(fileTreeExpandedStorageAtom, {
        ...current,
        [worktreePath]: paths,
      })
    },
  ),
)