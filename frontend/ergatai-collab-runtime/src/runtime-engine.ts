import { randomUUID } from "node:crypto"

import type {
  ArtifactReference,
  CollaborationMode,
  InteractionEvent,
  RuntimeEvent,
} from "./protocol"
import {
  normalizeInteraction,
  routeInteraction,
} from "./policy-router"
import {
  SessionStore,
  isRuntimeRoute,
  type RuntimeSession,
  type RuntimeSessionStatus,
} from "./session-store"

interface PendingApprovalRecord {
  approvalId: string
  sessionId: string
  runId: string
}

interface ActiveRun {
  controller: AbortController
  sessionId: string
  runId: string
}

export interface RuntimeOperationResult {
  route?: string
  sessionId?: string
  runId?: string
  events: RuntimeEvent[]
}

export class RuntimeOperationError extends Error {
  constructor(
    readonly code: "invalid_command",
    message: string,
  ) {
    super(message)
  }
}

function abortError(): Error {
  const error = new Error("Collaboration run cancelled")
  error.name = "AbortError"
  return error
}

export class RuntimeEngine {
  private readonly sessions = new Map<string, RuntimeSession>()
  private readonly sessionsByChat = new Map<string, string>()
  private readonly sessionsByRun = new Map<string, string>()
  private readonly approvals = new Map<string, PendingApprovalRecord>()
  private readonly activeRuns = new Map<string, ActiveRun>()

  constructor(private readonly store: SessionStore) {}

  get activeSessionCount(): number {
    return Array.from(this.sessions.values()).filter(
      (session) => session.status === "running" || session.status === "awaiting_approval",
    ).length
  }

  async recover(): Promise<void> {
    for (const session of this.store.list()) {
      this.restoreSession(session)
    }
  }

  async applyInteraction(
    interaction: InteractionEvent,
    collaborationMode: CollaborationMode = "supervisor",
  ): Promise<RuntimeOperationResult> {
    const normalized = normalizeInteraction(interaction)

    switch (normalized.type) {
      case "approval_granted":
        return this.approve(normalized.approvalId)
      case "approval_rejected":
        return this.reject(normalized.approvalId)
      case "run_cancelled":
        return this.cancel({ runId: normalized.runId })
      default:
        break
    }

    const route = routeInteraction(normalized, {
      collaborationMode,
      hasPersistedDagSession: false,
    })
    if (!isRuntimeRoute(route)) {
      return { route, events: [] }
    }

    const chatId =
      normalized.type === "message_submitted" || normalized.type === "agent_mentioned"
        ? normalized.chatId
        : ""
    let session = chatId ? this.getSessionByChat(chatId) : undefined
    const isNewSession = !session
    if (!session) {
      session = {
        sessionId: randomUUID(),
        chatId,
        mode: collaborationMode,
        route,
        status: "running",
        currentStep: "prepare",
        participants: [],
        summaries: [],
        decisions: [],
        artifactRefs: [],
        pendingApproval: null,
      }
      this.sessions.set(session.sessionId, session)
      if (chatId) {
        this.sessionsByChat.set(chatId, session.sessionId)
      }
    } else {
      session.mode = collaborationMode
      session.route = route
      session.status = "running"
      session.currentStep = "prepare"
      session.participants = []
      session.summaries = []
      session.decisions = []
      session.artifactRefs = []
      session.pendingApproval = null
    }

    const runId = randomUUID()
    session.lastRunId = runId
    this.sessionsByRun.set(runId, session.sessionId)
    const controller = new AbortController()
    this.activeRuns.set(runId, {
      controller,
      sessionId: session.sessionId,
      runId,
    })

    const events: RuntimeEvent[] = []
    if (isNewSession) {
      events.push({
        type: "session_created",
        sessionId: session.sessionId,
        chatId,
        mode: collaborationMode,
        route,
      })
    }

    const title =
      normalized.type === "message_submitted"
        ? normalized.text.slice(0, 120) || "Collaboration task"
        : "Agent collaboration"
    events.push({
      type: "run_created",
      sessionId: session.sessionId,
      runId,
      chatId,
      title,
    })

    const mentions = normalized.type === "message_submitted" ? normalized.mentions : []
    for (const agentId of mentions) {
      events.push({
        type: "agent_assigned",
        sessionId: session.sessionId,
        runId,
        chatId,
        agentId,
      })
    }

    const artifactRefs: ArtifactReference[] = []
    const workspaceId =
      normalized.type === "message_submitted" ? normalized.workspaceId : undefined
    if (workspaceId) {
      artifactRefs.push({
        id: workspaceId,
        kind: "workspace",
        managedBy: "rust",
      })
      session.artifactRefs.push(...artifactRefs)
    }

    try {
      const runEvents = await this.runRoute({
        session,
        runId,
        mentions,
        signal: controller.signal,
      })
      return {
        route,
        sessionId: session.sessionId,
        runId,
        events: [...events, ...runEvents],
      }
    } catch (error) {
      if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        session.status = "cancelled"
        session.currentStep = "cancelled"
        session.pendingApproval = null
        session.summaries.push({
          summary: "Collaboration run cancelled",
          status: "cancelled",
        })
        this.store.save(session)
        return {
          route,
          sessionId: session.sessionId,
          runId,
          events: [
            ...events,
            {
              type: "progress_updated",
              sessionId: session.sessionId,
              runId,
              chatId,
              summary: "Collaboration run cancelled",
              status: "cancelled",
            },
            {
              type: "session_cancelled",
              sessionId: session.sessionId,
              chatId,
            },
          ],
        }
      }

      session.status = "failed"
      session.currentStep = "failed"
      session.pendingApproval = null
      const reason = error instanceof Error ? error.message : "Collaboration run failed"
      session.summaries.push({ summary: reason, status: "failed" })
      this.store.save(session)
      return {
        route,
        sessionId: session.sessionId,
        runId,
        events: [
          ...events,
          {
            type: "session_failed",
            sessionId: session.sessionId,
            chatId,
            reason,
          },
        ],
      }
    } finally {
      this.activeRuns.delete(runId)
    }
  }

  async resumeSession(sessionId: string): Promise<RuntimeOperationResult> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new RuntimeOperationError("invalid_command", "unknown session")
    }
    if (session.status === "awaiting_approval") {
      throw new RuntimeOperationError("invalid_command", "session requires approval")
    }
    if (
      session.status === "completed" ||
      session.status === "failed" ||
      session.status === "cancelled"
    ) {
      throw new RuntimeOperationError("invalid_command", "session is not resumable")
    }

    const runId = session.lastRunId ?? randomUUID()
    this.sessionsByRun.set(runId, session.sessionId)
    const controller = new AbortController()
    this.activeRuns.set(runId, {
      controller,
      sessionId: session.sessionId,
      runId,
    })
    try {
      const runEvents = await this.runRoute({
        session,
        runId,
        mentions: [],
        signal: controller.signal,
      })
      return {
        route: session.route,
        sessionId: session.sessionId,
        runId,
        events: runEvents,
      }
    } catch (error) {
      this.activeRuns.delete(runId)
      throw error
    }
  }

  async approve(approvalId: string): Promise<RuntimeOperationResult> {
    return this.resolveApproval(approvalId, "approved")
  }

  async reject(approvalId: string): Promise<RuntimeOperationResult> {
    return this.resolveApproval(approvalId, "rejected")
  }

  async cancel(target: { sessionId?: string; runId?: string }): Promise<RuntimeOperationResult> {
    const activeRun = target.runId
      ? this.activeRuns.get(target.runId)
      : Array.from(this.activeRuns.values()).find(
          (run) => target.sessionId && run.sessionId === target.sessionId,
        )

    if (activeRun) {
      activeRun.controller.abort()
      return {
        sessionId: activeRun.sessionId,
        runId: activeRun.runId,
        events: [],
      }
    }

    const sessionId = target.sessionId
      ?? (target.runId ? this.findSessionIdByRun(target.runId) : undefined)
    const session = sessionId ? this.sessions.get(sessionId) : undefined
    if (!session) {
      throw new RuntimeOperationError("invalid_command", "unknown session")
    }

    if (session.pendingApproval) {
      this.approvals.delete(session.pendingApproval.approvalId)
    }
    session.status = "cancelled"
    session.currentStep = "cancelled"
    session.pendingApproval = null
    session.summaries.push({
      summary: "Collaboration session cancelled",
      status: "cancelled",
    })
    this.store.save(session)

    return {
      route: session.route,
      sessionId: session.sessionId,
      runId: target.runId,
      events: [
        ...(target.runId
          ? [{
              type: "run_cancelled",
              sessionId: session.sessionId,
              runId: target.runId,
              chatId: session.chatId,
            } satisfies RuntimeEvent]
          : []),
        {
          type: "session_cancelled",
          sessionId: session.sessionId,
          chatId: session.chatId,
        },
      ],
    }
  }

  private async runRoute(input: {
    session: RuntimeSession
    runId: string
    mentions: string[]
    signal: AbortSignal
  }): Promise<RuntimeEvent[]> {
    if (input.signal.aborted) {
      throw abortError()
    }

    switch (input.session.route) {
      case "supervisor_session":
        return this.runSupervisor(input)
      case "group_session":
        return this.runGroup(input)
      case "single_agent_run":
        return this.runSingleAgent(input)
      case "dag_import":
        return this.runDagImport(input)
    }
  }

  private async runSupervisor(input: {
    session: RuntimeSession
    runId: string
    mentions: string[]
    signal: AbortSignal
  }): Promise<RuntimeEvent[]> {
    const { session, runId, mentions } = input
    session.participants = mentions.length > 0 ? [...mentions] : ["supervisor"]

    session.currentStep = "planning"
    session.summaries.push({ summary: "Supervisor planned the task", status: "running" })
    this.store.save(session)
    const events = [this.progress(session, runId, "Supervisor planned the task", "running")]

    session.currentStep = "assigning"
    session.summaries.push({ summary: "Workers assigned", status: "running" })
    this.store.save(session)
    events.push(this.progress(session, runId, "Workers assigned", "running"))

    session.currentStep = "executing"
    session.summaries.push({ summary: "Workers returned summaries", status: "running" })
    this.store.save(session)
    events.push(this.progress(session, runId, "Workers returned summaries", "running"))

    const approvalId = `approval:${runId}`
    const approvalSummary = "Supervisor requests approval before finalizing"
    session.currentStep = "reviewing"
    session.status = "awaiting_approval"
    session.pendingApproval = {
      runId,
      approvalId,
      summary: approvalSummary,
    }
    session.summaries.push({ summary: approvalSummary, status: "awaiting_approval" })
    this.approvals.set(approvalId, {
      approvalId,
      sessionId: session.sessionId,
      runId,
    })
    this.store.save(session)

    events.push(this.progress(session, runId, approvalSummary, "awaiting_approval"))
    events.push({
      type: "approval_required",
      sessionId: session.sessionId,
      chatId: session.chatId,
      runId,
      approvalId,
      summary: approvalSummary,
    })
    return events
  }

  private async runGroup(input: {
    session: RuntimeSession
    runId: string
    mentions: string[]
    signal: AbortSignal
  }): Promise<RuntimeEvent[]> {
    const { session, runId, mentions } = input
    if (input.signal.aborted) {
      throw abortError()
    }

    session.participants = input.mentions.length > 0 ? [...input.mentions] : ["group"]
    session.currentStep = "routing"
    session.summaries.push({ summary: "Group participants routed", status: "running" })
    this.store.save(session)
    const events = [this.progress(session, runId, "Group participants routed", "running")]

    session.currentStep = "collecting"
    session.summaries.push({ summary: "Participant contributions collected", status: "running" })
    this.store.save(session)
    events.push(this.progress(session, runId, "Participant contributions collected", "running"))

    session.currentStep = "synthesizing"
    return [...events, ...this.complete(session, runId, "Group response synthesized")]
  }

  private async runSingleAgent(input: {
    session: RuntimeSession
    runId: string
    signal: AbortSignal
  }): Promise<RuntimeEvent[]> {
    const { session, runId } = input
    if (input.signal.aborted) {
      throw abortError()
    }

    session.currentStep = "executing"
    session.summaries.push({ summary: "Agent run completed", status: "running" })
    this.store.save(session)
    const events = [this.progress(session, runId, "Agent run completed", "running")]
    return [...events, ...this.complete(session, runId, "Run finalized")]
  }

  private async runDagImport(input: {
    session: RuntimeSession
    runId: string
    signal: AbortSignal
  }): Promise<RuntimeEvent[]> {
    const { session, runId } = input
    if (input.signal.aborted) {
      throw abortError()
    }

    session.currentStep = "validating"
    session.summaries.push({ summary: "DAG dependencies validated", status: "running" })
    this.store.save(session)
    const events = [this.progress(session, runId, "DAG dependencies validated", "running")]
    session.decisions.push("DAG imported into compatibility runtime")
    return [...events, ...this.complete(session, runId, "DAG compatibility run completed")]
  }

  private async resolveApproval(
    approvalId: string,
    decision: "approved" | "rejected",
  ): Promise<RuntimeOperationResult> {
    const approval = this.approvals.get(approvalId)
    if (!approval) {
      throw new RuntimeOperationError("invalid_command", "unknown approval")
    }

    const session = this.sessions.get(approval.sessionId)
    if (!session || session.pendingApproval?.approvalId !== approvalId) {
      throw new RuntimeOperationError("invalid_command", "unknown approval")
    }

    this.approvals.delete(approvalId)
    session.pendingApproval = null
    if (decision === "approved") {
      session.decisions.push("Approval granted")
      return {
        route: session.route,
        sessionId: session.sessionId,
        runId: approval.runId,
        events: this.complete(session, approval.runId, "Supervisor approved the result"),
      }
    }

    session.status = "failed"
    session.currentStep = "rejected"
    session.decisions.push("Approval rejected")
    session.summaries.push({ summary: "Supervisor rejected the plan", status: "failed" })
    this.store.save(session)
    return {
      route: session.route,
      sessionId: session.sessionId,
      runId: approval.runId,
      events: [
        this.progress(session, approval.runId, "Supervisor rejected the plan", "failed"),
        {
          type: "session_failed",
          sessionId: session.sessionId,
          chatId: session.chatId,
          reason: "Supervisor rejected the plan",
        },
      ],
    }
  }

  private complete(session: RuntimeSession, runId: string, summary: string): RuntimeEvent[] {
    session.status = "completed"
    session.currentStep = "completed"
    session.pendingApproval = null
    session.summaries.push({ summary, status: "completed" })
    this.store.save(session)

    return [
      this.progress(session, runId, summary, "completed"),
      {
        type: "session_completed",
        sessionId: session.sessionId,
        chatId: session.chatId,
      },
    ]
  }

  private progress(
    session: RuntimeSession,
    runId: string,
    summary: string,
    status: RuntimeSessionStatus,
  ): RuntimeEvent {
    return {
      type: "progress_updated",
      sessionId: session.sessionId,
      runId,
      chatId: session.chatId,
      summary,
      status,
    }
  }

  private getSessionByChat(chatId: string): RuntimeSession | undefined {
    const sessionId = this.sessionsByChat.get(chatId)
    return sessionId ? this.sessions.get(sessionId) : undefined
  }

  private findSessionIdByRun(runId: string): string | undefined {
    const sessionId = this.sessionsByRun.get(runId)
    if (sessionId) {
      return sessionId
    }

    for (const approval of this.approvals.values()) {
      if (approval.runId === runId) {
        return approval.sessionId
      }
    }
    return undefined
  }

  private restoreSession(session: RuntimeSession): void {
    if (this.sessions.has(session.sessionId)) {
      return
    }

    this.sessions.set(session.sessionId, session)
    if (session.chatId) {
      this.sessionsByChat.set(session.chatId, session.sessionId)
    }
    if (session.lastRunId) {
      this.sessionsByRun.set(session.lastRunId, session.sessionId)
    }
    if (session.pendingApproval) {
      this.approvals.set(session.pendingApproval.approvalId, {
        approvalId: session.pendingApproval.approvalId,
        sessionId: session.sessionId,
        runId: session.pendingApproval.runId,
      })
    }
  }
}
