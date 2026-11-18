import { useCallback, useSyncExternalStore } from "react"
import { atom } from "jotai"
import { atomFamily } from "jotai/utils"

export type SubagentMessage = {
  kind: "text" | "thinking" | "tool_call" | "tool_result"
  content: string
  createdAt: number
  // Structured fields for tool_call / tool_result
  toolCallId?: string
  toolName?: string
  input?: unknown
  state?: "pending" | "completed" | "failed"
  output?: unknown
}

export type SubagentRunMeta = {
  subagentSessionId: string
  name: string
  task: string
  state: string
  startedAt: number
  updatedAt: number
  parentToolUseId?: string | null
}

export type SubagentToolCall = {
  toolCallId: string
  toolName: string
  input: unknown
  state: "pending" | "completed" | "failed"
  output?: unknown
}

export type SubagentRenderPart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool-call"; toolCall: SubagentToolCall }

export type SubagentRenderMessage = {
  id: string
  role: "assistant"
  parts: SubagentRenderPart[]
}

type Listener = () => void

const MESSAGE_CAP = 500
const CHAR_CAP = 200_000

const EMPTY_MESSAGES: SubagentMessage[] = []
const EMPTY_RUNS: SubagentRunMeta[] = []

const messageState = new Map<string, SubagentMessage[]>()
const runState = new Map<string, Map<string, SubagentRunMeta>>()

const messageListeners = new Map<string, Set<Listener>>()
const runListeners = new Map<string, Set<Listener>>()

function messageKey(agentId: string, subagentSessionId: string): string {
  return `${agentId}::${subagentSessionId}`
}

function notifyMessage(key: string) {
  const listeners = messageListeners.get(key)
  if (!listeners) return
  for (const listener of listeners) listener()
}

function notifyRun(agentId: string) {
  const listeners = runListeners.get(agentId)
  if (!listeners) return
  for (const listener of listeners) listener()
}

function totalChars(messages: SubagentMessage[]): number {
  let total = 0
  for (const message of messages) total += message.content.length
  return total
}

export function appendSubagentMessage(
  agentId: string,
  subagentSessionId: string,
  message: SubagentMessage,
): void {
  const key = messageKey(agentId, subagentSessionId)
  const prev = messageState.get(key) ?? []
  let next = [...prev, message]

  // Enforce bounded buffer.
  while (
    next.length > 1 &&
    (next.length > MESSAGE_CAP || totalChars(next) > CHAR_CAP)
  ) {
    next = next.slice(1)
  }

  messageState.set(key, next)
  notifyMessage(key)

  // Ensure a run meta exists so the UI can list this subagent even if the
  // spawn event arrived late or was missed.
  const runs = runState.get(agentId) ?? new Map<string, SubagentRunMeta>()
  if (!runs.has(subagentSessionId)) {
    runs.set(subagentSessionId, {
      subagentSessionId,
      name: subagentSessionId,
      task: "",
      state: "running",
      startedAt: message.createdAt,
      updatedAt: message.createdAt,
    })
    runState.set(agentId, runs)
    notifyRun(agentId)
  } else {
    const existing = runs.get(subagentSessionId)!
    existing.updatedAt = Math.max(existing.updatedAt, message.createdAt)
    // Do not notify on every chunk; run list ordering/state does not depend on
    // per-token updates and notifying would cause excessive re-renders.
  }
}

export function getSubagentMessages(
  agentId: string,
  subagentSessionId: string,
): SubagentMessage[] {
  return messageState.get(messageKey(agentId, subagentSessionId)) ?? EMPTY_MESSAGES
}

export function subscribeSubagentMessages(
  agentId: string,
  subagentSessionId: string,
  listener: Listener,
): () => void {
  const key = messageKey(agentId, subagentSessionId)
  const set = messageListeners.get(key) ?? new Set<Listener>()
  set.add(listener)
  messageListeners.set(key, set)
  return () => {
    const current = messageListeners.get(key)
    if (!current) return
    current.delete(listener)
    if (current.size === 0) messageListeners.delete(key)
  }
}

export function useSubagentMessages(
  agentId: string | null,
  subagentSessionId: string | null,
): SubagentMessage[] {
  const key =
    agentId && subagentSessionId ? messageKey(agentId, subagentSessionId) : null

  const subscribe = useCallback(
    (listener: Listener) => {
      if (!agentId || !subagentSessionId) return () => {}
      return subscribeSubagentMessages(agentId, subagentSessionId, listener)
    },
    [agentId, subagentSessionId],
  )

  const getSnapshot = useCallback(
    () =>
      agentId && subagentSessionId
        ? getSubagentMessages(agentId, subagentSessionId)
        : EMPTY_MESSAGES,
    [agentId, subagentSessionId],
  )

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

// ---------------------------------------------------------------------------
// Run meta store
// ---------------------------------------------------------------------------

export function upsertSubagentRun(agentId: string, meta: SubagentRunMeta): void {
  const runs = runState.get(agentId) ?? new Map<string, SubagentRunMeta>()
  const existing = runs.get(meta.subagentSessionId)
  runs.set(meta.subagentSessionId, {
    ...existing,
    ...meta,
    startedAt: existing?.startedAt ?? meta.startedAt,
    updatedAt: Math.max(existing?.updatedAt ?? 0, meta.updatedAt),
    name: meta.name || existing?.name || meta.subagentSessionId,
    task: meta.task || existing?.task || "",
  })
  runState.set(agentId, runs)
  notifyRun(agentId)
}

export function updateSubagentRunState(
  agentId: string,
  subagentSessionId: string,
  state: string,
): void {
  const runs = runState.get(agentId) ?? new Map<string, SubagentRunMeta>()
  const existing = runs.get(subagentSessionId)
  const now = Date.now()
  runs.set(subagentSessionId, {
    subagentSessionId,
    name: existing?.name ?? subagentSessionId,
    task: existing?.task ?? "",
    state,
    startedAt: existing?.startedAt ?? now,
    updatedAt: now,
    parentToolUseId: existing?.parentToolUseId,
  })
  runState.set(agentId, runs)
  notifyRun(agentId)
}

export function getSubagentRuns(agentId: string): SubagentRunMeta[] {
  const runs = runState.get(agentId)
  if (!runs) return EMPTY_RUNS
  return Array.from(runs.values()).sort((a, b) => b.updatedAt - a.updatedAt)
}

export function subscribeSubagentRuns(agentId: string, listener: Listener): () => void {
  const set = runListeners.get(agentId) ?? new Set<Listener>()
  set.add(listener)
  runListeners.set(agentId, set)
  return () => {
    const current = runListeners.get(agentId)
    if (!current) return
    current.delete(listener)
    if (current.size === 0) runListeners.delete(agentId)
  }
}

export function useSubagentRuns(agentId: string | null): SubagentRunMeta[] {
  const subscribe = useCallback(
    (listener: Listener) => {
      if (!agentId) return () => {}
      return subscribeSubagentRuns(agentId, listener)
    },
    [agentId],
  )

  const getSnapshot = useCallback(
    () => (agentId ? getSubagentRuns(agentId) : EMPTY_RUNS),
    [agentId],
  )

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

export function clearSubagentMessages(
  agentId: string,
  subagentSessionId?: string,
): void {
  if (subagentSessionId) {
    const key = messageKey(agentId, subagentSessionId)
    messageState.delete(key)
    notifyMessage(key)
    return
  }

  const prefix = `${agentId}::`
  for (const key of Array.from(messageState.keys())) {
    if (key.startsWith(prefix)) {
      messageState.delete(key)
      notifyMessage(key)
    }
  }
}

export function clearSubagentRuns(agentId: string): void {
  runState.delete(agentId)
  notifyRun(agentId)
}

export function clearSubagentState(agentId: string): void {
  clearSubagentMessages(agentId)
  clearSubagentRuns(agentId)
}

// Shared selection state so the status-card rail (selector) and the main chat
// surface (conversation view) stay in sync.
export const selectedSubagentSessionIdAtomFamily = atomFamily((conversationId: string) =>
  atom<string | null>(null),
)

// ---------------------------------------------------------------------------
// Conversion helpers
// ---------------------------------------------------------------------------

export function toSubagentRenderMessages(
  subagentSessionId: string,
  messages: SubagentMessage[],
): SubagentRenderMessage[] {
  if (messages.length === 0) return []

  const parts: SubagentRenderPart[] = []

  for (const message of messages) {
    if (message.kind === "text") {
      const last = parts[parts.length - 1]
      if (last?.type === "text") {
        last.text += message.content
      } else {
        parts.push({ type: "text", text: message.content })
      }
      continue
    }

    if (message.kind === "thinking") {
      const last = parts[parts.length - 1]
      if (last?.type === "reasoning") {
        last.text += message.content
      } else {
        parts.push({ type: "reasoning", text: message.content })
      }
      continue
    }

    if (message.kind === "tool_call") {
      parts.push({
        type: "tool-call",
        toolCall: {
          toolCallId: message.toolCallId ?? `${subagentSessionId}-${parts.length}`,
          toolName: message.toolName ?? "tool",
          input: message.input,
          state: message.state ?? "pending",
          output: message.output,
        },
      })
      continue
    }

    if (message.kind === "tool_result") {
      const target = [...parts]
        .reverse()
        .find(
          (part): part is Extract<SubagentRenderPart, { type: "tool-call" }> =>
            part.type === "tool-call" &&
            (message.toolCallId ? part.toolCall.toolCallId === message.toolCallId : true),
        )
      if (target) {
        target.toolCall.state = message.state ?? "completed"
        target.toolCall.output = message.output ?? message.content
      }
    }
  }

  // Drop empty text/reasoning parts that can appear from empty deltas.
  const cleaned = parts.filter((part) => {
    if (part.type === "text" || part.type === "reasoning") {
      return part.text.trim().length > 0
    }
    return true
  })

  if (cleaned.length === 0) return []

  return [
    {
      id: subagentSessionId,
      role: "assistant",
      parts: cleaned,
    },
  ]
}