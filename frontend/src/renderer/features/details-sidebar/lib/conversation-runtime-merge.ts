import type {
  ConversationRetryState,
  ConversationRuntimeEvent,
  ConversationRuntimeState,
} from "./conversation-runtime-gateway"

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
    retry?: ConversationRetryState | null
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
      const gapEvents = [...snapshot.events]
      const gapHasError = gapEvents.some(
        (e) => e.event.type === "error" || (e.event.type === "done" && e.event.stop_reason === "error"),
      )
      return {
        conversationId,
        status: gapHasError && snapshot.status === "completed" ? "error" : snapshot.status,
        connectionStatus: "reconnecting",
        epoch: snapshot.epoch,
        turnId,
        lastSequence: snapshot.lastSequence,
        firstSequence: snapshot.firstSequence ?? undefined,
        events: gapEvents,
        retry: snapshot.retry ?? undefined,
        startedAtMs: snapshot.startedAtMs ?? undefined,
        updatedAtMs: snapshot.updatedAtMs ?? undefined,
      }
    }
    events.push(event)
    lastSequence = event.sequence
  }

  const hasError = events.some(
    (e) => e.event.type === "error" || (e.event.type === "done" && e.event.stop_reason === "error"),
  )

  return {
    conversationId,
    status: hasError && snapshot.status === "completed" ? "error" : snapshot.status,
    connectionStatus: "connected",
    epoch: snapshot.epoch,
    turnId,
    lastSequence,
    firstSequence: snapshot.firstSequence ?? undefined,
    events,
    retry: snapshot.retry ?? undefined,
    startedAtMs: snapshot.startedAtMs ?? undefined,
    updatedAtMs: snapshot.updatedAtMs ?? undefined,
  }
}
