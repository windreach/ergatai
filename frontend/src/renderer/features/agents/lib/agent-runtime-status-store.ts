import { useCallback, useSyncExternalStore } from "react"

import { agentContractApi, type AgentSummary } from "./agent-contract-api"

export type AgentRuntimeStatusState = {
  agents: AgentSummary[]
  status: "idle" | "loading" | "ready" | "error"
  updatedAt: number | null
  error?: string
}

type Listener = () => void

const POLL_INTERVAL_MS = 5_000
const STOP_DELAY_MS = 10_000

let state: AgentRuntimeStatusState = {
  agents: [],
  status: "idle",
  updatedAt: null,
}

let listenerCount = 0
let pollTimer: ReturnType<typeof setInterval> | null = null
let stopTimer: ReturnType<typeof setTimeout> | null = null
let refreshInFlight = false

const listeners = new Set<Listener>()

const disabledState: AgentRuntimeStatusState = {
  agents: [],
  status: "idle",
  updatedAt: null,
}

function setState(next: Partial<AgentRuntimeStatusState>) {
  state = { ...state, ...next }
  for (const listener of listeners) {
    listener()
  }
}

async function refreshAgents() {
  if (refreshInFlight) return
  refreshInFlight = true

  if (!state.updatedAt) {
    setState({ status: "loading" })
  }

  try {
    const agents = await agentContractApi.listAgents()
    setState({
      agents,
      status: "ready",
      updatedAt: Date.now(),
      error: undefined,
    })
  } catch (error) {
    setState({
      status: state.agents.length > 0 ? "ready" : "error",
      error: error instanceof Error ? error.message : "Failed to load agent status",
    })
  } finally {
    refreshInFlight = false
  }
}

function startPolling() {
  if (pollTimer) return
  void refreshAgents()
  pollTimer = setInterval(() => {
    void refreshAgents()
  }, POLL_INTERVAL_MS)
}

function stopPolling() {
  if (!pollTimer) return
  clearInterval(pollTimer)
  pollTimer = null
}

export function subscribeAgentRuntimeStatus(listener: Listener): () => void {
  listeners.add(listener)
  listenerCount += 1

  if (stopTimer) {
    clearTimeout(stopTimer)
    stopTimer = null
  }
  startPolling()

  return () => {
    listeners.delete(listener)
    listenerCount = Math.max(0, listenerCount - 1)
    if (listenerCount === 0 && !stopTimer) {
      stopTimer = setTimeout(() => {
        stopTimer = null
        if (listenerCount === 0) stopPolling()
      }, STOP_DELAY_MS)
    }
  }
}

export function getAgentRuntimeStatusState(): AgentRuntimeStatusState {
  return state
}

export function refreshAgentRuntimeStatus() {
  return refreshAgents()
}

export function useAgentRuntimeAgents(enabled = true): AgentRuntimeStatusState {
  const subscribe = useCallback(
    (listener: Listener) => {
      if (!enabled) return () => {}
      return subscribeAgentRuntimeStatus(listener)
    },
    [enabled],
  )

  const getSnapshot = useCallback(() => {
    return enabled ? state : undefined
  }, [enabled])

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot) ?? disabledState
}
