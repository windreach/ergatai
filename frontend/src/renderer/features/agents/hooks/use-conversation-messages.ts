import { useMemo, useSyncExternalStore } from "react"
import { trpcClient } from "../../../lib/trpc"

/**
 * Message type representing a normalized conversation message.
 *
 * This mirrors the shape returned by `trpc.ergatai.listConversationMessages`
 * (see `mapMessage` in the main-process tRPC router).
 */
export type Message = {
  id: string
  conversationId: string
  sequence: number
  role: string
  fromAgentId?: string | null
  fromAgentName?: string | null
  messageType?: string | null
  turnId?: string | null
  projectionKind?: string | null
  originMessageId?: string | null
  parts: unknown[]
  metadata: Record<string, unknown> | null
  createdAt: Date
}

/**
 * P3 SHARED SUBSCRIPTION PIPELINE — streaming via the agent endpoint.
 *
 * `/api/v1/conversations/{id}/sse` was deprecated; live streaming for agent
 * conversations flows through the agent stream endpoint
 * (`/api/v1/agents/{agentId}/stream`, exposed as `subscribeAgentStream`),
 * which emits `AgentOutputEvent` deltas while a turn is running and completes
 * on `done`.
 *
 * Per conversation there is exactly ONE pipeline (reference-counted):
 * - history loads from REST;
 * - agent-stream deltas build/refresh a live "streaming preview" message so
 *   panels render the reply character-by-character (same-id upsert);
 * - after `done`, the pipeline re-fetches history, drops the preview once the
 *   persisted message exists, and reconnects the stream for the next turn.
 *
 * Consumers read through `useSyncExternalStore`, so React only re-renders when
 * the shared state object actually changes.
 */

const PIPELINE_CLEANUP_GRACE_MS = 5_000
/** Delay before re-fetching history after a turn completes (persist settle). */
const HISTORY_REFETCH_AFTER_DONE_MS = 1_000
/** Delay before re-opening the agent stream after it completes. */
const STREAM_RECONNECT_DELAY_MS = 300
/** Give up reconnecting after this many consecutive stream errors. */
const MAX_CONSECUTIVE_STREAM_ERRORS = 3

const PREVIEW_MESSAGE_ID = "__streaming_preview__"

type ConversationState = {
  messages: Message[]
  isLoading: boolean
  historyLoaded: boolean
  error: Error | null
}

type StreamDeltaEvent = {
  type: string
  delta?: string
  id?: string
  name?: string
  input?: unknown
  output?: unknown
  error?: string
  stop_reason?: string
}

type ConversationEvent =
  | { type: "reset" }
  | { type: "history_loaded"; messages: Message[] }
  | { type: "stream_delta"; event: StreamDeltaEvent }
  | { type: "history_error"; error: Error }
  | { type: "stream_error"; error: Error }

const INITIAL_STATE: ConversationState = {
  messages: [],
  isLoading: true,
  historyLoaded: false,
  error: null,
}

function mergeMessage(incoming: Message, existing?: Message): Message {
  if (!existing) return incoming
  // Field-wise merge: the newer event wins for present values, but a nullish
  // field falls back to what we already have. This keeps richer versions
  // (e.g. SSE updates that carry correlation metadata) from being downgraded
  // by an older snapshot that simply has not caught up yet.
  return {
    ...existing,
    ...incoming,
    parts: incoming.parts ?? existing.parts,
    metadata: incoming.metadata ?? existing.metadata,
    messageType: incoming.messageType ?? existing.messageType,
    projectionKind: incoming.projectionKind ?? existing.projectionKind,
  }
}

function isPreview(message: Message): boolean {
  return message.id === PREVIEW_MESSAGE_ID
}

function upsertPreview(
  messages: Message[],
  update: (preview: Message) => Message,
): Message[] {
  const existing = messages.find(isPreview)
  const next = update(
    existing ?? {
      id: PREVIEW_MESSAGE_ID,
      conversationId: "",
      sequence: Number.MAX_SAFE_INTEGER,
      role: "assistant",
      parts: [],
      metadata: { streaming: true },
      createdAt: new Date(),
    },
  )
  if (existing) {
    return messages.map((m) => (isPreview(m) ? next : m))
  }
  // Keep the preview at the end of the list (synthetic max sequence).
  return [...messages, next]
}

function applyStreamDelta(state: ConversationState, event: StreamDeltaEvent): ConversationState {
  switch (event.type) {
    case "thinking": {
      const delta = event.delta ?? ""
      if (!delta) return state
      return {
        ...state,
        error: null,
        messages: upsertPreview(state.messages, (preview) => ({
          ...preview,
          parts: (() => {
            const parts = [...(preview.parts as Array<Record<string, unknown>>)]
            const index = parts.findIndex((p) => p.type === "reasoning")
            if (index >= 0) {
              parts[index] = {
                ...parts[index],
                text: String(parts[index].text ?? "") + delta,
              }
            } else {
              parts.push({ type: "reasoning", text: delta })
            }
            return parts
          })(),
        })),
      }
    }

    case "tool_call_start": {
      const toolCallId = event.id ?? ""
      return {
        ...state,
        error: null,
        messages: upsertPreview(state.messages, (preview) => ({
          ...preview,
          parts: [
            ...(preview.parts as Array<Record<string, unknown>>),
            {
              type: `tool-${event.name ?? "unknown"}`,
              toolCallId,
              state: event.input != null ? "input-available" : "input-streaming",
              input: event.input ?? {},
            },
          ],
        })),
      }
    }

    case "tool_call_input": {
      const toolCallId = event.id ?? ""
      return {
        ...state,
        error: null,
        messages: upsertPreview(state.messages, (preview) => ({
          ...preview,
          parts: (preview.parts as Array<Record<string, unknown>>).map((part) =>
            part.toolCallId === toolCallId
              ? {
                  ...part,
                  state: "input-streaming",
                  inputTextDelta: String(part.inputTextDelta ?? "") + (event.delta ?? ""),
                }
              : part,
          ),
        })),
      }
    }

    case "tool_call_complete": {
      const toolCallId = event.id ?? ""
      return {
        ...state,
        error: null,
        messages: upsertPreview(state.messages, (preview) => ({
          ...preview,
          parts: (preview.parts as Array<Record<string, unknown>>).map((part) =>
            part.toolCallId === toolCallId
              ? {
                  ...part,
                  state: "output-available",
                  input: event.input ?? part.input,
                  output: event.output ?? part.output,
                }
              : part,
          ),
        })),
      }
    }

    case "tool_call_error": {
      const toolCallId = event.id ?? ""
      return {
        ...state,
        error: null,
        messages: upsertPreview(state.messages, (preview) => ({
          ...preview,
          parts: (preview.parts as Array<Record<string, unknown>>).map((part) =>
            part.toolCallId === toolCallId ? { ...part, state: "output-error", error: event.error } : part,
          ),
        })),
      }
    }

    // done / turn_started / session_title_update / message_inserted etc. carry
    // no renderable delta for the preview; the pipeline layer reacts to `done`.
    default:
      return state
  }
}

function reducer(state: ConversationState, event: ConversationEvent): ConversationState {
  switch (event.type) {
    case "reset":
      return { ...INITIAL_STATE }

    case "history_error":
      return { ...state, isLoading: false, error: event.error }

    case "history_loaded": {
      // Merge history into whatever the live pipeline already delivered so a
      // refetch can never silently drop newer fields. The streaming preview is
      // dropped once history carries the persisted turn output (it only
      // exists while the durable copy has not landed yet).
      const byId = new Map<string, Message>()
      for (const msg of state.messages) {
        if (!isPreview(msg)) byId.set(msg.id, msg)
      }
      for (const msg of event.messages) {
        byId.set(msg.id, mergeMessage(msg, byId.get(msg.id)))
      }
      const messages = [...byId.values()].sort((a, b) => a.sequence - b.sequence)
      return { messages, isLoading: false, historyLoaded: true, error: null }
    }

    case "stream_delta":
      return applyStreamDelta(state, event.event)

    case "stream_error":
      return { ...state, error: event.error }
  }
}

function toError(value: unknown): Error {
  if (value instanceof Error) return value
  return new Error(
    typeof value === "string" ? value : "Conversation pipeline error",
  )
}

class ConversationPipeline {
  readonly conversationId: string
  private agentId: string | null

  private state: ConversationState = { ...INITIAL_STATE }
  private listeners = new Set<() => void>()
  private refCount = 0
  private running = false
  private unsubStream: (() => void) | null = null
  private cleanupTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private refetchTimer: ReturnType<typeof setTimeout> | null = null
  private lastSequence = 0
  private fetchEpoch = 0
  private consecutiveStreamErrors = 0
  private doneReceived = false

  constructor(conversationId: string, agentId: string | null) {
    this.conversationId = conversationId
    this.agentId = agentId
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    this.refCount++

    if (this.cleanupTimer) {
      // A warm pipeline was waiting to be torn down — keep its live stream
      // and cached state instead of restarting from scratch.
      clearTimeout(this.cleanupTimer)
      this.cleanupTimer = null
    }

    if (this.refCount === 1 && !this.running) {
      this.start()
    }

    let unsubscribed = false
    return () => {
      if (unsubscribed) return
      unsubscribed = true
      this.listeners.delete(listener)
      this.refCount = Math.max(0, this.refCount - 1)
      if (this.refCount === 0 && this.running) {
        this.scheduleCleanup()
      }
    }
  }

  getSnapshot = (): ConversationState => this.state

  private notify() {
    for (const listener of this.listeners) listener()
  }

  private setState(next: ConversationState) {
    if (next === this.state) return
    this.state = next
    this.notify()
  }

  private dispatch(event: ConversationEvent) {
    this.setState(reducer(this.state, event))
  }

  private start() {
    this.running = true
    this.fetchEpoch++
    const epoch = this.fetchEpoch
    void this.loadHistory(epoch)
  }

  private async loadHistory(epoch: number) {
    try {
      const history = await trpcClient.ergatai.listConversationMessages.query({
        conversationId: this.conversationId,
      })
      if (this.isStale(epoch)) return
      this.dispatch({ type: "history_loaded", messages: history })
      this.lastSequence = Math.max(...history.map((m) => m.sequence), 0)
    } catch (err) {
      if (this.isStale(epoch)) return
      this.dispatch({ type: "history_error", error: toError(err) })
    }
    if (this.isStale(epoch)) return
    if (!this.unsubStream) {
      this.openStream()
    }
  }

  private isStale(epoch: number): boolean {
    // Abandoned (everyone left) or restarted — drop in-flight results.
    return epoch !== this.fetchEpoch || this.refCount === 0
  }

  private openStream() {
    if (this.unsubStream || !this.agentId) return
    const subscription = trpcClient.ergatai.subscribeAgentStream.subscribe(
      { agentId: this.agentId },
      {
        onData: (event) => {
          const type = (event as { type?: string }).type
          const deltaEvent = event as StreamDeltaEvent
          this.dispatch({ type: "stream_delta", event: deltaEvent })
          if (type !== "done") {
            // Healthy traffic — reset the reconnect backoff counter only on
            // real data, otherwise a connect→error loop never trips the cap.
            this.consecutiveStreamErrors = 0
          }
          if (type === "done") {
            this.doneReceived = true
            // The turn finished; its durable copy lands moments later.
            this.scheduleHistoryRefetch()
          }
        },
        onError: (err) => {
          this.dispatch({ type: "stream_error", error: toError(err) })
          this.scheduleStreamRetry()
        },
        onComplete: () => {
          // The stream closes after every turn (done) — reopen it so later
          // turns keep streaming while any consumer is attached.
          this.scheduleStreamRetry()
        },
      },
    )
    this.unsubStream = () => subscription.unsubscribe()
  }

  private scheduleStreamRetry() {
    this.unsubStream = null
    if (this.refCount === 0 || !this.agentId) return
    if (this.reconnectTimer) return
    this.consecutiveStreamErrors++
    if (this.consecutiveStreamErrors > MAX_CONSECUTIVE_STREAM_ERRORS) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.refCount > 0 && this.running && !this.unsubStream) {
        this.openStream()
      }
    }, STREAM_RECONNECT_DELAY_MS)
  }

  private scheduleHistoryRefetch() {
    if (this.refetchTimer) return
    this.refetchTimer = setTimeout(() => {
      this.refetchTimer = null
      if (this.refCount > 0 && this.running) {
        void this.loadHistory(this.fetchEpoch)
      }
    }, HISTORY_REFETCH_AFTER_DONE_MS)
  }

  scheduleCleanup() {
    this.cleanupTimer = setTimeout(() => {
      this.cleanupTimer = null
      this.teardown()
    }, PIPELINE_CLEANUP_GRACE_MS)
  }

  /** Test isolation / registry reset support. */
  teardown() {
    this.running = false
    this.fetchEpoch++
    if (this.cleanupTimer) {
      clearTimeout(this.cleanupTimer)
      this.cleanupTimer = null
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.refetchTimer) {
      clearTimeout(this.refetchTimer)
      this.refetchTimer = null
    }
    this.unsubStream?.()
    this.unsubStream = null
    this.lastSequence = 0
    this.state = { ...INITIAL_STATE }
    pipelines.delete(this.conversationId)
  }
}

const pipelines = new Map<string, ConversationPipeline>()

function getPipeline(conversationId: string, agentId: string | null): ConversationPipeline {
  let pipeline = pipelines.get(conversationId)
  if (!pipeline) {
    pipeline = new ConversationPipeline(conversationId, agentId)
    pipelines.set(conversationId, pipeline)
  }
  return pipeline
}

/** Test isolation helper: tear down every live pipeline immediately. */
export function __resetConversationPipelinesForTests(): void {
  for (const pipeline of [...pipelines.values()]) {
    pipeline.teardown()
  }
}

export function useConversationMessages(
  conversationId: string,
  agentId?: string,
): {
  messages: Message[]
  isLoading: boolean
  error: Error | null
} {
  const pipeline = useMemo(
    () => getPipeline(conversationId, agentId ?? null),
    [conversationId, agentId],
  )

  const state = useSyncExternalStore(
    pipeline.subscribe,
    pipeline.getSnapshot,
    pipeline.getSnapshot,
  )

  return {
    messages: state.messages,
    isLoading: state.isLoading,
    error: state.error,
  }
}
