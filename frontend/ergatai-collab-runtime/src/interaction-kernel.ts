import { randomUUID } from "node:crypto"

import type { CollaborationMode, InteractionEvent, RuntimeEvent } from "./protocol"
import {
  normalizeInteraction,
  routeInteraction,
} from "./policy-router"

interface InteractionSession {
  sessionId: string
  chatId: string
  mode: CollaborationMode
  route: string
}

export interface InteractionRouting {
  route: string
  sessionId?: string
  runId?: string
  events: RuntimeEvent[]
}

export class InteractionKernel {
  private readonly sessions = new Map<string, InteractionSession>()
  private readonly MAX_SESSIONS = 1000

  apply(
    interaction: InteractionEvent,
    collaborationMode: CollaborationMode = "supervisor",
  ): InteractionRouting {
    const normalized = normalizeInteraction(interaction)
    const route = routeInteraction(normalized, {
      collaborationMode,
      hasPersistedDagSession: false,
    })

    if (route === "lightweight_chat") {
      return { route, events: [] }
    }

    const chatId =
      normalized.type === "message_submitted" ||
      normalized.type === "agent_mentioned"
        ? normalized.chatId
        : ""

    // Reject empty chatId to prevent session collision
    if (!chatId) {
      return { route: "error", events: [{ type: "error", message: "Missing chatId" }] }
    }

    const existing = this.sessions.get(chatId)
    const session = existing ?? {
      sessionId: randomUUID(),
      chatId,
      mode: collaborationMode,
      route,
    }
    if (!existing) {
      // Evict oldest session if map is too large
      if (this.sessions.size >= this.MAX_SESSIONS) {
        const firstKey = this.sessions.keys().next().value
        if (firstKey !== undefined) {
          this.sessions.delete(firstKey)
        }
      }
      this.sessions.set(chatId, session)
    }

    const runId = randomUUID()
    const title =
      normalized.type === "message_submitted"
        ? normalized.text.slice(0, 120) || "Collaboration task"
        : "Agent collaboration"
    const events: RuntimeEvent[] = []

    if (!existing) {
      events.push({
        type: "session_created",
        sessionId: session.sessionId,
        chatId,
        mode: collaborationMode,
        route,
      })
    }

    events.push({
      type: "run_created",
      sessionId: session.sessionId,
      runId,
      chatId,
      title,
    })

    if (
      normalized.type === "message_submitted" &&
      normalized.mentions.length > 0
    ) {
      for (const agentId of normalized.mentions) {
        events.push({
          type: "agent_assigned",
          sessionId: session.sessionId,
          runId,
          chatId,
          agentId,
        })
      }
    }

    events.push({
      type: "progress_updated",
      sessionId: session.sessionId,
      runId,
      chatId,
      summary:
        route === "group_session"
          ? "Collaboration session routing participants"
          : "Preparing agent execution",
      status: "running",
    })

    return { route, sessionId: session.sessionId, runId, events }
  }

  get activeSessionCount(): number {
    return this.sessions.size
  }
}
