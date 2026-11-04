import { useCallback, useSyncExternalStore } from "react"

import { trpcClient } from "../../../lib/trpc"
import { createLogger } from "../../../../main/lib/logger"

import {
  readPersistedSequence,
  persistSequence,
  removePersistedSequence,
} from "../../conversation"

export type RuntimeAgentEvent = {
  type: string
  role?: string | null
  delta?: string
  id?: string
  name?: string
  input?: unknown
  output?: unknown
  locations?: Array<{ path: string; line?: number }>
  title?: string
  subagent_session_id?: string
  task?: string
  state?: string
  stop_reason?: string
  message?: string
}

export type ConversationRuntimeEvent = {
  conversationId: string
  turnId: string
  sequence: number
  timestampMs: number
  event: RuntimeAgentEvent
}

export type ConversationRuntimeState = {
  conversationId: string
  status: "idle" | "streaming" | "completed" | "error"
  connectionStatus: "connecting" | "connected" | "reconnecting" | "stopped"
  epoch?: string
  turnId?: string
  lastSequence: number
  firstSequence?: number
  events: ConversationRuntimeEvent[]
  startedAtMs?: number
  updatedAtMs?: number
  error?: string
}

type Listener = (state: ConversationRuntimeState) => void

type RuntimeChannel = {
  state: ConversationRuntimeState
  listeners: Set<Listener>
  unsubscribe?: { unsubscribe: () => void }
  reconnectTimer?: ReturnType<typeof setTimeout>
  stopTimer?: ReturnType<typeof setTimeout>
  retryAttempt: number
  forceSnapshot?: boolean
}

const MAX_EVENTS = 5_000
const log = createLogger("ConversationRuntime")
const STOP_DELAY_MS = 30_000
const MAX_RETRY_DELAY_MS = 10_000

function resolveRuntimeStatus(
  eventType: string,
): "idle" | "streaming" | "completed" | "error" {
  if (eventType === "done") return "completed"
  if (eventType === "error") return "error"
  return "streaming"
}

const channels = new Map<string, RuntimeChannel>()

function cloneState(channel: RuntimeChannel): ConversationRuntimeState {
  return {
    ...channel.state,
    events: [...channel.state.events],
  }
}

function notify(channel: RuntimeChannel) {
  const state = cloneState(channel)
  for (const listener of channel.listeners) {
    listener(state)
  }
}

export function shouldResnapshot(
  previous: ConversationRuntimeState | undefined,
  snapshot: {
    epoch: string
    turnId?: string | null
    firstSequence?: number | null
  },
): boolean {
  if (!previous || previous.epoch !== snapshot.epoch) return true
  if (snapshot.firstSequence == null) return previous.events.length > 0
  return snapshot.firstSequence > previous.lastSequence + 1
}

export function mergeSnapshot(
  conversationId: string,
  previous: ConversationRuntimeState | undefined,
  snapshot: {
    epoch: string
    turnId?: string | null
    status: ConversationRuntimeState["status"]
    lastSequence: number
    firstSequence?: number | null
    events: ConversationRuntimeEvent[]
    startedAtMs?: number | null
    updatedAtMs?: number | null
  },
): ConversationRuntimeState {
  const reset = shouldResnapshot(previous, snapshot)
  const turnId = snapshot.turnId ?? undefined
  const base = reset
    ? []
    : (previous?.events ?? []).filter(event => !turnId || event.turnId === turnId)

  const events = [...base]
  const firstEventSequence =
    snapshot.events.length > 0
      ? snapshot.events[0].sequence
      : (snapshot.firstSequence ?? null)
  let lastSequence = reset
    ? (snapshot.events.length > 0 && firstEventSequence != null
        ? firstEventSequence - 1
        : snapshot.lastSequence)
    : (previous?.lastSequence ?? 0)
  for (const event of snapshot.events) {
    if (event.conversationId !== conversationId) continue
    if (event.sequence <= lastSequence) continue
    if (event.sequence > lastSequence + 1) {
      // A gap cannot be repaired incrementally. The next snapshot will become
      // the source of truth.
      return {
        conversationId,
        status: snapshot.status,
        connectionStatus: "reconnecting",
        epoch: snapshot.epoch,
        turnId,
        lastSequence: snapshot.lastSequence,
        firstSequence: snapshot.firstSequence ?? undefined,
        events: [...snapshot.events],
        startedAtMs: snapshot.startedAtMs ?? undefined,
        updatedAtMs: snapshot.updatedAtMs ?? undefined,
      }
    }
    events.push(event)
    lastSequence = event.sequence
  }

  return {
    conversationId,
    status: snapshot.status,
    connectionStatus: "connected",
    epoch: snapshot.epoch,
    turnId,
    lastSequence,
    firstSequence: snapshot.firstSequence ?? undefined,
    events,
    startedAtMs: snapshot.startedAtMs ?? undefined,
    updatedAtMs: snapshot.updatedAtMs ?? undefined,
  }
}

function connect(conversationId: string) {
  const channel = channels.get(conversationId)
  if (!channel || channel.unsubscribe) return
  log.debug("connect", { conversationId, afterSequence: channel.state.epoch ? channel.state.lastSequence : undefined })

  if (channel.reconnectTimer) {
    clearTimeout(channel.reconnectTimer)
    channel.reconnectTimer = undefined
  }

  channel.state = {
    ...channel.state,
    connectionStatus: "connecting",
  }
  notify(channel)

  channel.unsubscribe = trpcClient.ergatai.subscribeConversationRuntime.subscribe(
    {
      conversationId,
      afterSequence: channel.forceSnapshot
        ? undefined
        : (channel.state.epoch ? channel.state.lastSequence : undefined),
    },
    {
      onData: (message) => {
        if (message.kind === "snapshot") {
          channel.state = mergeSnapshot(conversationId, channel.state, message.snapshot)
          channel.retryAttempt = 0
          channel.forceSnapshot = false
          // Keep persisted sequence only while a turn is active. Clearing it on
          // terminal turns avoids stale high-water marks blocking the next turn.
          if (channel.state.status === "completed" || channel.state.status === "error") {
            removePersistedSequence(conversationId)
          } else {
            persistSequence(conversationId, channel.state.lastSequence)
          }
        } else {
          const event = message.event
          if (event.conversationId !== conversationId) return
          if (event.turnId !== channel.state.turnId) {
            channel.state = {
              ...channel.state,
              status: resolveRuntimeStatus(event.event.type),
              turnId: event.turnId,
              lastSequence: event.sequence,
              events: [event],
              startedAtMs: event.timestampMs,
              updatedAtMs: event.timestampMs,
            }
            // Persist lastSequence for new turn, but clear it if the turn is
            // already terminal so the next turn starts from a clean snapshot.
            if (channel.state.status === "completed" || channel.state.status === "error") {
              removePersistedSequence(conversationId)
            } else {
              persistSequence(conversationId, channel.state.lastSequence)
            }
            notify(channel)
            return
          }
          if (event.sequence <= channel.state.lastSequence) return

          if (event.sequence > channel.state.lastSequence + 1) {
            log.warn("runtime event gap detected", {
              conversationId,
              expected: channel.state.lastSequence + 1,
              received: event.sequence,
            })
            channel.forceSnapshot = true
            removePersistedSequence(conversationId)
            channel.state = {
              ...channel.state,
              connectionStatus: "reconnecting",
              error: "Runtime event gap detected",
            }
            notify(channel)
            reconnect(conversationId, 0)
            return
          }

          channel.state = {
            ...channel.state,
            status: resolveRuntimeStatus(event.event.type),
            lastSequence: event.sequence,
            events: [...channel.state.events, event].slice(-MAX_EVENTS),
            updatedAtMs: event.timestampMs,
          }
          // Persist lastSequence while streaming; clear it once terminal so a
          // later turn cannot be skipped due to a stale high-water mark.
          if (channel.state.status === "completed" || channel.state.status === "error") {
            removePersistedSequence(conversationId)
          } else {
            persistSequence(conversationId, channel.state.lastSequence)
          }
        }

        notify(channel)
      },
      onError: (error) => {
        channel.state = {
          ...channel.state,
          connectionStatus: "reconnecting",
          error: error instanceof Error ? error.message : "Runtime stream failed",
        }
        notify(channel)
        reconnect(conversationId)
      },
      onComplete: () => {
        // The backend intentionally keeps this stream open across turns, so a
        // complete here means the transport ended and should be retried.
        if (channel.listeners.size > 0) {
          reconnect(conversationId)
        }
      },
    },
  )
}

function reconnect(conversationId: string, attempt?: number) {
  const channel = channels.get(conversationId)
  if (!channel) return
  log.debug("reconnect", { conversationId, attempt: channel.retryAttempt })

  channel.unsubscribe?.unsubscribe()
  channel.unsubscribe = undefined
  channel.retryAttempt = attempt ?? channel.retryAttempt + 1
  const delay = Math.min(1_000 * 2 ** channel.retryAttempt, MAX_RETRY_DELAY_MS)
  if (channel.reconnectTimer) clearTimeout(channel.reconnectTimer)
  channel.reconnectTimer = setTimeout(() => {
    channel.reconnectTimer = undefined
    if (channel.listeners.size > 0) connect(conversationId)
  }, delay)
}

function scheduleStop(conversationId: string) {
  const channel = channels.get(conversationId)
  if (!channel) return
  if (channel.stopTimer) clearTimeout(channel.stopTimer)
  channel.stopTimer = setTimeout(() => {
    channel.stopTimer = undefined
    if (channel.listeners.size > 0) return
    channel.unsubscribe?.unsubscribe()
    channel.unsubscribe = undefined
    if (channel.reconnectTimer) {
      clearTimeout(channel.reconnectTimer)
      channel.reconnectTimer = undefined
    }
    channel.state = {
      ...channel.state,
      connectionStatus: "stopped",
    }
    notify(channel)
    // Drop the channel after it has been idle to avoid unbounded growth
    // across many conversations in long-running sessions.
    channels.delete(conversationId)
  }, STOP_DELAY_MS)
}

export function subscribeConversationRuntime(
  conversationId: string,
  listener: Listener,
): () => void {
  let channel = channels.get(conversationId)
  if (!channel) {
    // Restore lastSequence from localStorage to enable stream resumption after UI reload
    const persistedSequence = readPersistedSequence(conversationId) ?? 0
    channel = {
      state: {
        conversationId,
        status: "idle",
        connectionStatus: "connecting",
        lastSequence: persistedSequence,
        events: [],
      },
      listeners: new Set(),
      retryAttempt: 0,
    }
    channels.set(conversationId, channel)
  }

  if (channel.stopTimer) {
    clearTimeout(channel.stopTimer)
    channel.stopTimer = undefined
  }
  channel.listeners.add(listener)
  listener(cloneState(channel))
  connect(conversationId)

  return () => {
    const current = channels.get(conversationId)
    if (!current) return
    current.listeners.delete(listener)
    if (current.listeners.size === 0) scheduleStop(conversationId)
  }
}

export function getConversationRuntimeState(
  conversationId: string,
): ConversationRuntimeState | undefined {
  return channels.get(conversationId)?.state
}

export function useConversationRuntime(
  conversationId: string | undefined,
  enabled = true,
): ConversationRuntimeState | undefined {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!enabled || !conversationId) return () => {}
      return subscribeConversationRuntime(conversationId, onStoreChange)
    },
    [conversationId, enabled],
  )

  const getSnapshot = useCallback(() => {
    if (!enabled || !conversationId) return undefined
    return getConversationRuntimeState(conversationId)
  }, [conversationId, enabled])

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
