// Modified from 1Code (Apache-2.0) by Ergatai — see MODIFICATIONS.md
import { atom } from "jotai"
import { atomWithStorage } from "jotai/utils"
import { atomFamily } from "jotai/utils"
import { atomWithWindowStorage } from "../../lib/window-storage"
import type { TerminalInstance } from "./types"

// Runtime atom for per-chat terminal sidebar state (not persisted, so re-entering
// the chat page does not auto-expand / "remember" expand state)
const terminalSidebarOpenStorageAtom = atom<Record<string, boolean>>({})

// Per-chat terminal sidebar open state (like diffSidebarOpenAtomFamily)
export const terminalSidebarOpenAtomFamily = atomFamily((chatId: string) =>
  atom(
    (get) => get(terminalSidebarOpenStorageAtom)[chatId] ?? false,
    (get, set, isOpen: boolean | ((prev: boolean) => boolean)) => {
      const current = get(terminalSidebarOpenStorageAtom)
      const currentValue = current[chatId] ?? false
      const newValue = typeof isOpen === "function" ? isOpen(currentValue) : isOpen
      set(terminalSidebarOpenStorageAtom, { ...current, [chatId]: newValue })
    },
  ),
)

// Deprecated: Keep for backwards compatibility, but should not be used
// Use terminalSidebarOpenAtomFamily(chatId) instead
export const terminalSidebarOpenAtom = atom(false)

export const terminalSidebarWidthAtom = atomWithStorage<number>(
  "terminal-sidebar-width",
  500,
  undefined,
  { getOnInit: true },
)

// Terminal cwd tracking - window-scoped, maps paneId to current working directory
export const terminalCwdAtom = atomWithWindowStorage<Record<string, string>>(
  "terminal-cwds",
  {},
  { getOnInit: true },
)

// Terminal display mode - sidebar (right) or bottom panel
export type TerminalDisplayMode = "side-peek" | "bottom"

export const terminalDisplayModeAtom = atomWithStorage<TerminalDisplayMode>(
  "terminal-display-mode",
  "side-peek",
  undefined,
  { getOnInit: true },
)

export const terminalBottomHeightAtom = atomWithStorage<number>(
  "terminal-bottom-height",
  300,
  undefined,
  { getOnInit: true },
)

// Terminal search open state - maps paneId to search visibility
export const terminalSearchOpenAtom = atom<Record<string, boolean>>({})

// ============================================================================
// Multi-Terminal State Management
// ============================================================================

/**
 * Map of scopeKey -> terminal instances.
 * Window-scoped so each window manages its own terminal instances.
 * Key is scopeKey: "path:<dir>" for shared (local mode) or "ws:<chatId>" for isolated (worktree).
 */
export const terminalsAtom = atomWithWindowStorage<
  Record<string, TerminalInstance[]>
>("terminals-by-scope", {}, { getOnInit: true })

/**
 * Map of scopeKey -> active terminal id.
 * Window-scoped - tracks which terminal is currently active for each scope in this window.
 * Key is scopeKey: "path:<dir>" for shared (local mode) or "ws:<chatId>" for isolated (worktree).
 */
export const activeTerminalIdAtom = atomWithWindowStorage<
  Record<string, string | null>
>("active-terminal-by-scope", {}, { getOnInit: true })

/**
 * Map of scopeKey -> selected agent terminal task id.
 *
 * The terminal sidebar shows agent tasks as read-only terminals; selecting one
 * switches the sidebar content from the PTY to the agent output. Kept in memory
 * because the task store itself is live-only.
 */
const activeAgentTerminalStorageAtom = atom<Record<string, string | null>>({})

export const activeAgentTerminalIdAtomFamily = atomFamily((scopeKey: string) =>
  atom(
    (get) => get(activeAgentTerminalStorageAtom)[scopeKey] ?? null,
    (get, set, terminalId: string | null) => {
      set(activeAgentTerminalStorageAtom, {
        ...get(activeAgentTerminalStorageAtom),
        [scopeKey]: terminalId,
      })
    },
  ),
)
