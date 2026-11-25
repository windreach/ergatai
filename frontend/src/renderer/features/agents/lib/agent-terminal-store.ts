import { useCallback, useSyncExternalStore } from "react"

export type AgentTerminalStatus = "running" | "completed" | "failed" | "cancelled"

/**
 * One terminal task reported by an agent through ACP extension metadata.
 *
 * Claude ACP reports command tools as display terminals. The runtime
 * accumulates each terminal and emits a `terminal_task_update` extension event
 * with the full snapshot, so this store only has to upsert by terminal id.
 */
export interface AgentTerminalTask {
  terminalId: string
  title: string
  command?: string
  output: string
  exitCode?: number | null
  signal?: string | null
  status: AgentTerminalStatus
  backgrounded: boolean
  /** Adapter async-task id when the command runs in the background. */
  asyncTaskId?: string
  /** First observed start time (Unix milliseconds). */
  startedAt: number
  /** Completion time once the task reaches a terminal status. */
  finishedAt?: number
  updatedAt: number
}

/** Only tasks that lived at least this long are mounted in the sidebar widget. */
export const MIN_AGENT_TERMINAL_LIFETIME_MS = 15_000

const EMPTY_TERMINALS: AgentTerminalTask[] = []
const MAX_TERMINALS_PER_CONVERSATION = 50
const MAX_OUTPUT_CHARS = 256 * 1024

const state = new Map<string, AgentTerminalTask[]>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function asStatus(value: unknown): AgentTerminalStatus {
  if (value === "completed" || value === "failed" || value === "cancelled") {
    return value
  }
  return "running"
}

function boundOutput(output: string): string {
  return output.length <= MAX_OUTPUT_CHARS
    ? output
    : output.slice(-MAX_OUTPUT_CHARS)
}

/** Whether the task has lived long enough to appear in the Terminal widget. */
export function isAgentTerminalVisible(
  task: AgentTerminalTask,
  now: number = Date.now(),
): boolean {
  // Background shell tasks are explicitly created by the agent and should be
  // visible immediately; the lifetime threshold only filters short foreground
  // commands that would otherwise flash in and out of the widget.
  if (task.backgrounded) return true
  const endedAt = task.finishedAt ?? now
  return endedAt - task.startedAt >= MIN_AGENT_TERMINAL_LIFETIME_MS
}

/**
 * Upsert the latest snapshot for one agent terminal task.
 *
 * Returns true when the payload was a terminal-task snapshot and the store
 * changed; false otherwise.
 */
export function applyAgentTerminalUpdate(
  conversationId: string,
  payload: unknown,
  observedAt?: number,
): boolean {
  if (!conversationId || !payload || typeof payload !== "object") return false

  const obj = payload as Record<string, unknown>
  const terminalId =
    asString(obj.terminal_id) ?? asString(obj.terminalId) ?? asString(obj.id)
  if (!terminalId) return false

  const previous = state.get(conversationId) ?? EMPTY_TERMINALS
  const index = previous.findIndex((item) => item.terminalId === terminalId)
  const previousTask = index >= 0 ? previous[index] : undefined

  const command = asString(obj.command)
  const incomingTitle = asString(obj.title)
  const title =
    incomingTitle && incomingTitle !== "Terminal"
      ? incomingTitle
      : command ??
        previousTask?.title ??
        incomingTitle ??
        terminalId
  const exitCode =
    typeof obj.exit_code === "number" || obj.exit_code === null
      ? (obj.exit_code as number | null)
      : typeof obj.exitCode === "number" || obj.exitCode === null
        ? (obj.exitCode as number | null)
        : undefined
  const signal =
    typeof obj.signal === "string" || obj.signal === null
      ? (obj.signal as string | null)
      : undefined

  const outputSnapshot = asString(obj.output)
  const outputDelta =
    asString(obj.output_delta) ?? asString(obj.outputDelta)
  const output = boundOutput(
    outputSnapshot !== undefined
      ? outputSnapshot
      : `${previousTask?.output ?? ""}${outputDelta ?? ""}`,
  )

  const incomingStatus = asStatus(obj.status)
  // For a background shell task the terminal's tool-result exit is premature;
  // only the async-task state update may finish it.
  const status =
    previousTask?.asyncTaskId &&
    previousTask.status === "running" &&
    incomingStatus !== "running" &&
    previousTask.finishedAt === undefined
      ? "running"
      : incomingStatus
  const updatedAt =
    asNumber(obj.updated_at) ??
    asNumber(obj.updatedAt) ??
    observedAt ??
    Date.now()
  const task: AgentTerminalTask = {
    terminalId,
    title,
    command,
    output,
    exitCode,
    signal,
    status,
    backgrounded: obj.backgrounded === true,
    asyncTaskId: previousTask?.asyncTaskId,
    startedAt: previousTask?.startedAt ?? updatedAt,
    finishedAt:
      status === "running"
        ? undefined
        : previousTask?.finishedAt ?? updatedAt,
    updatedAt,
  }

  upsertAgentTerminal(conversationId, task)
  return true
}

function upsertAgentTerminal(
  conversationId: string,
  task: AgentTerminalTask,
): void {
  const previous = state.get(conversationId) ?? EMPTY_TERMINALS
  const index = previous.findIndex(
    (item) => item.terminalId === task.terminalId,
  )
  const next =
    index >= 0
      ? previous.map((item, itemIndex) =>
          itemIndex === index ? task : item,
        )
      : // Newest first. An agent command can emit a terminal update before the
        // widget mounts, so keep the newest tasks at the top of the list.
        [task, ...previous].slice(0, MAX_TERMINALS_PER_CONVERSATION)

  state.set(conversationId, next)
  notify()
}

/**
 * Bind a shell async task to its display terminal.
 *
 * Claude ACP reports background commands both as a display terminal and as an
 * `async_task_spawned` event. The terminal's tool-result exit is premature; the
 * async-task state update is the real completion signal.
 */
export function applyAgentAsyncTaskSpawned(
  conversationId: string,
  payload: unknown,
  observedAt?: number,
): boolean {
  if (!conversationId || !payload || typeof payload !== "object") return false
  const obj = payload as Record<string, unknown>
  if (asString(obj.taskType) !== "shell") return false

  const terminalId =
    asString(obj.toolCallId) ?? asString(obj.tool_call_id)
  const asyncTaskId =
    asString(obj.asyncTaskId) ?? asString(obj.async_task_id)
  if (!terminalId || !asyncTaskId) return false

  const name = asString(obj.name) ?? asString(obj.description)
  const previous = state.get(conversationId) ?? EMPTY_TERMINALS
  const previousTask = previous.find(
    (task) => task.terminalId === terminalId,
  )

  const now = observedAt ?? Date.now()
  upsertAgentTerminal(conversationId, {
    ...(previousTask ?? {
      terminalId,
      title: name ?? terminalId,
      output: "",
      backgrounded: true,
      startedAt: now,
      updatedAt: now,
    }),
    terminalId,
    title: name ?? previousTask?.title ?? terminalId,
    status: "running",
    backgrounded: true,
    exitCode: undefined,
    signal: undefined,
    asyncTaskId,
    startedAt: previousTask?.startedAt ?? now,
    finishedAt: undefined,
    updatedAt: now,
  })
  return true
}

/** Apply the completion state of a background shell task. */
export function applyAgentAsyncTaskState(
  conversationId: string,
  payload: unknown,
  observedAt?: number,
): boolean {
  if (!conversationId || !payload || typeof payload !== "object") return false
  const obj = payload as Record<string, unknown>
  const asyncTaskId =
    asString(obj.asyncTaskId) ?? asString(obj.async_task_id)
  const rawState = asString(obj.state)
  if (!asyncTaskId || !rawState) return false

  const status: AgentTerminalStatus | null =
    rawState === "completed"
      ? "completed"
      : rawState === "failed"
        ? "failed"
        : rawState === "cancelled" ||
            rawState === "cancelled_by_user" ||
            rawState === "stopped"
          ? "cancelled"
          : null
  if (!status) return false

  const previous = state.get(conversationId) ?? EMPTY_TERMINALS
  const index = previous.findIndex(
    (task) => task.asyncTaskId === asyncTaskId,
  )
  if (index < 0) return false

  const task = previous[index]
  const now = observedAt ?? Date.now()
  upsertAgentTerminal(conversationId, {
    ...task,
    status,
    backgrounded: true,
    // The async-task end is authoritative even if a premature terminal exit
    // already recorded an earlier finish time.
    finishedAt: now,
    updatedAt: now,
  })
  return true
}

/**
 * Dispatch one ACP extension event into the terminal task store.
 *
 * Covers terminal display updates plus the background-task lifecycle that
 * keeps a shell task running after its tool call completes.
 */
export function applyAgentTerminalExtension(
  conversationId: string,
  kind: string | undefined,
  payload: unknown,
  observedAt?: number,
): boolean {
  switch (kind) {
    case "terminal_task_update":
      return applyAgentTerminalUpdate(conversationId, payload, observedAt)
    case "async_task_spawned":
      return applyAgentAsyncTaskSpawned(conversationId, payload, observedAt)
    case "async_task_state_update":
      return applyAgentAsyncTaskState(conversationId, payload, observedAt)
    default:
      return false
  }
}

export function getAgentTerminals(conversationId: string): AgentTerminalTask[] {
  return state.get(conversationId) ?? EMPTY_TERMINALS
}

export function subscribeAgentTerminals(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function clearAgentTerminals(conversationId: string): void {
  if (!state.delete(conversationId)) return
  notify()
}

/** Test isolation helper. */
export function resetAgentTerminalStoreForTests(): void {
  state.clear()
  notify()
}

export function useAgentTerminals(
  conversationId: string | null | undefined,
): AgentTerminalTask[] {
  const subscribe = useCallback((listener: () => void) => {
    return subscribeAgentTerminals(listener)
  }, [])

  const getSnapshot = useCallback(() => {
    return conversationId ? getAgentTerminals(conversationId) : EMPTY_TERMINALS
  }, [conversationId])

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
