import { atom } from "jotai"
import { atomFamily } from "jotai/utils"

import { atomWithWindowStorage } from "@/lib/window-storage"

import type {
  PanelId,
  PanelLinkCommand,
  PanelLinkScopeState,
  PanelLinkSnapshot,
  PanelState,
  PanelTarget,
} from "./types"

const EMPTY_PANEL_STATES: Partial<Record<PanelId, PanelState>> = {}

export function createPanelLinkScopeState(): PanelLinkScopeState {
  return {
    activeTarget: null,
    activeTargetSource: "restore",
    panels: EMPTY_PANEL_STATES,
    updatedAt: new Date(0).toISOString(),
  }
}

export function createPanelLinkScopeKey(input: {
  chatId?: string | null
  workspaceId?: string | null
}): string {
  const workspaceId = input.workspaceId || "default-workspace"
  const chatId = input.chatId || "new-chat"

  return `${workspaceId}::${chatId}`
}

const panelLinkScopesAtom = atomWithWindowStorage<Record<string, PanelLinkScopeState>>(
  "panel-link:scopes",
  {},
  { getOnInit: true },
)

export const panelLinkScopeAtomFamily = atomFamily((scopeKey: string) =>
  atom(
    (get) =>
      get(panelLinkScopesAtom)[scopeKey] ?? createPanelLinkScopeState(),
    (get, set, nextState: PanelLinkScopeState) => {
      const scopes = get(panelLinkScopesAtom)
      set(panelLinkScopesAtom, {
        ...scopes,
        [scopeKey]: nextState,
      })
    },
  ),
)

export const panelLinkActiveTargetAtomFamily = atomFamily((scopeKey: string) =>
  atom((get) => get(panelLinkScopeAtomFamily(scopeKey)).activeTarget),
)

export const panelLinkPanelAtomFamily = atomFamily(
  (input: { scopeKey: string; panelId: PanelId }) =>
    atom(
      (get) =>
        get(panelLinkScopeAtomFamily(input.scopeKey)).panels[input.panelId] ??
        null,
    ),
)

export const panelLinkSnapshotAtomFamily = atomFamily((scopeKey: string) =>
  atom((get): PanelLinkSnapshot => ({
    scopeKey,
    state: get(panelLinkScopeAtomFamily(scopeKey)),
  })),
)

export const allPanelLinkSnapshotsAtom = atom((get) => {
  const scopes = get(panelLinkScopesAtom)

  return Object.entries(scopes).map<PanelLinkSnapshot>(
    ([scopeKey, state]) => ({ scopeKey, state }),
  )
})

function clonePanels(
  panels: Partial<Record<PanelId, PanelState>>,
): Partial<Record<PanelId, PanelState>> {
  return { ...panels }
}

function getOrCreatePanel(
  panels: Partial<Record<PanelId, PanelState>>,
  panelId: PanelId,
): PanelState {
  return panels[panelId] ?? { open: false, target: null, pinned: false }
}

function isSameTarget(
  first: PanelTarget | null | undefined,
  second: PanelTarget | null | undefined,
): boolean {
  return Boolean(
    first &&
      second &&
      first.kind === second.kind &&
      first.id === second.id &&
      first.path === second.path,
  )
}

function withRequestToken(target: PanelTarget): PanelTarget {
  return {
    ...target,
    metadata: {
      ...target.metadata,
      requestToken: crypto.randomUUID(),
    },
  }
}

function applyPanelUpdate(
  state: PanelLinkScopeState,
  panelId: PanelId,
  update: (panel: PanelState) => PanelState,
): PanelLinkScopeState {
  const panels = clonePanels(state.panels)

  panels[panelId] = update(getOrCreatePanel(panels, panelId))

  return { ...state, panels, updatedAt: new Date().toISOString() }
}

function replaceExclusivePanels(
  state: PanelLinkScopeState,
  keepPanelId: PanelId,
): PanelLinkScopeState {
  const panels = clonePanels(state.panels)
  let changed = false

  for (const [panelId, panel] of Object.entries(panels) as [PanelId, PanelState][]) {
    if (panelId === keepPanelId || !panel.open || panel.pinned) continue

    panels[panelId] = { ...panel, open: false }
    changed = true
  }

  return changed ? { ...state, panels } : state
}

function reducePanelLinkCommand(
  currentState: PanelLinkScopeState,
  command: PanelLinkCommand,
): PanelLinkScopeState {
  let state = currentState

  switch (command.type) {
    case "focus-target": {
      const target = command.source === "user" ? withRequestToken(command.target) : command.target
      state = {
        ...state,
        activeTarget: target,
        activeTargetSource: command.source,
        updatedAt: new Date().toISOString(),
      }

      for (const panelId of command.options?.panelIds ?? []) {
        state = applyPanelUpdate(state, panelId, (panel) => ({
          ...panel,
          open: true,
          target: panel.pinned ? panel.target : target,
        }))
      }

      if (command.options?.replaceExclusive) {
        const firstPanelId = command.options.panelIds?.[0]

        if (firstPanelId) {
          state = replaceExclusivePanels(state, firstPanelId)
        }
      }

      return state
    }

    case "open-panel": {
      if (command.replaceExclusive) {
        state = replaceExclusivePanels(state, command.panelId)
      }

      state = applyPanelUpdate(state, command.panelId, (panel) => ({
        ...panel,
        open: true,
        displayMode: command.displayMode ?? panel.displayMode,
        target: panel.pinned && command.target ? panel.target : command.target ?? panel.target,
      }))

      if (command.target && !panelTargetMatchesActive(state.activeTarget, command.target)) {
        state = {
          ...state,
          activeTarget: command.target,
          activeTargetSource: command.source,
        }
      }

      return state
    }

    case "close-panel":
      return applyPanelUpdate(state, command.panelId, (panel) => ({
        ...panel,
        open: false,
      }))

    case "toggle-panel": {
      const panel = getOrCreatePanel(state.panels, command.panelId)

      return reducePanelLinkCommand(state, {
        type: panel.open ? "close-panel" : "open-panel",
        panelId: command.panelId,
        target: command.target,
        source: command.source,
        displayMode: command.displayMode,
        replaceExclusive: command.replaceExclusive,
      })
    }

    case "set-panel-pinned":
      return applyPanelUpdate(state, command.panelId, (panel) => ({
        ...panel,
        pinned: command.pinned,
      }))

    case "sync-panel-target":
      return applyPanelUpdate(state, command.panelId, (panel) => ({
        ...panel,
        displayMode: command.displayMode ?? panel.displayMode,
        target: panel.pinned ? panel.target : command.target,
      }))

    case "sync-panel":
      return applyPanelUpdate(state, command.panelId, (panel) => ({
        ...panel,
        open: command.open,
        pinned: command.pinned ?? panel.pinned,
        displayMode: command.displayMode ?? panel.displayMode,
        target: panel.pinned && command.target !== undefined ? panel.target : command.target ?? panel.target,
      }))
  }
}

function panelTargetMatchesActive(
  activeTarget: PanelTarget | null,
  target: PanelTarget | null | undefined,
): boolean {
  return isSameTarget(activeTarget, target)
}

export const panelLinkCommandAtomFamily = atomFamily((scopeKey: string) =>
  atom(null, (get, set, command: PanelLinkCommand) => {
    const scopeAtom = panelLinkScopeAtomFamily(scopeKey)
    const nextState = reducePanelLinkCommand(get(scopeAtom), command)

    set(scopeAtom, nextState)
  }),
)
