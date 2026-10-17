export type ImplicitCollaborationStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"

export interface ImplicitCollaborationTask {
  id: string
  sessionId: string
  runId?: string
  title: string
  status: ImplicitCollaborationStatus
  agents: string[]
  summary: string
  updatedAt: number
}

export type ImplicitRuntimeEvent =
  | {
      type: "session_created"
      sessionId: string
      chatId: string
      mode: "supervisor" | "group"
      route: string
    }
  | {
      type: "run_created"
      sessionId: string
      runId: string
      chatId: string
      title: string
    }
  | {
      type: "agent_assigned"
      sessionId: string
      runId: string
      chatId: string
      agentId: string
    }
  | {
      type: "progress_updated"
      sessionId: string
      runId: string
      chatId: string
      summary: string
      status: "running"
    }
  | {
      type: "session_completed"
      sessionId: string
      chatId: string
    }
  | {
      type: "session_failed"
      sessionId: string
      chatId: string
      reason: string
    }

const AGENT_MENTION_PATTERN = /@\[agent:([^\]]+)\]/g

export function extractAgentMentions(text: string): string[] {
  return Array.from(
    new Set(
      Array.from(text.matchAll(AGENT_MENTION_PATTERN)).map(
        (match) => match[1],
      ),
    ),
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

export function parseImplicitRuntimeEvent(
  rawEvent: unknown,
): ImplicitRuntimeEvent | null {
  if (!isRecord(rawEvent)) return null

  const type = readString(rawEvent.type)
  const sessionId = readString(rawEvent.sessionId)
  const chatId = readString(rawEvent.chatId)

  if (!sessionId || !chatId) return null

  switch (type) {
    case "session_created": {
      const mode = readString(rawEvent.mode)
      const route = readString(rawEvent.route)
      if (mode !== "supervisor" && mode !== "group") return null

      return {
        type,
        sessionId,
        chatId,
        mode,
        route: route ?? "supervisor_session",
      }
    }
    case "run_created": {
      const runId = readString(rawEvent.runId)
      const title = readString(rawEvent.title)
      if (!runId) return null

      return {
        type,
        sessionId,
        runId,
        chatId,
        title: title || "Collaboration task",
      }
    }
    case "agent_assigned": {
      const runId = readString(rawEvent.runId)
      const agentId = readString(rawEvent.agentId)
      if (!runId || !agentId) return null

      return { type, sessionId, runId, chatId, agentId }
    }
    case "progress_updated": {
      const runId = readString(rawEvent.runId)
      const summary = readString(rawEvent.summary)
      if (!runId) return null

      return {
        type,
        sessionId,
        runId,
        chatId,
        summary: summary || "Working on collaboration task",
        status: "running",
      }
    }
    case "session_completed":
      return { type, sessionId, chatId }
    case "session_failed": {
      const reason = readString(rawEvent.reason)
      return {
        type,
        sessionId,
        chatId,
        reason: reason || "Collaboration session failed",
      }
    }
    default:
      return null
  }
}

export function applyImplicitRuntimeEvent(
  tasks: ImplicitCollaborationTask[],
  event: ImplicitRuntimeEvent,
): ImplicitCollaborationTask[] {
  const taskIndex = tasks.findIndex(
    (task) => task.sessionId === event.sessionId,
  )
  const updatedAt = Date.now()

  if (taskIndex === -1) {
    if (event.type !== "session_created") return tasks

    return [
      ...tasks,
      {
        id: event.sessionId,
        sessionId: event.sessionId,
        title: "Collaboration task",
        status: "pending",
        agents: [],
        summary: "Collaboration session created",
        updatedAt,
      },
    ]
  }

  const task = tasks[taskIndex]
  const nextTask: ImplicitCollaborationTask = { ...task, updatedAt }

  if (event.type === "run_created") {
    nextTask.runId = event.runId
    nextTask.title = event.title
    nextTask.status = "running"
    nextTask.summary = "Preparing agent execution"
  } else if (event.type === "agent_assigned") {
    nextTask.agents = Array.from(new Set([...task.agents, event.agentId]))
  } else if (event.type === "progress_updated") {
    nextTask.runId = event.runId
    nextTask.summary = event.summary
    nextTask.status = "running"
  } else if (event.type === "session_completed") {
    nextTask.status = "completed"
    nextTask.summary = "Collaboration session completed"
  } else if (event.type === "session_failed") {
    nextTask.status = "failed"
    nextTask.summary = event.reason
  }

  return [
    ...tasks.slice(0, taskIndex),
    nextTask,
    ...tasks.slice(taskIndex + 1),
  ]
}
