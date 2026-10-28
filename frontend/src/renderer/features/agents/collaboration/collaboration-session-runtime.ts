"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { trpcClient } from "../../../lib/trpc"
import { createLogger } from "../../../../main/lib/logger"

const log = createLogger("CollaborationSession")

export const COLLABORATION_SESSION_FLAG_KEY =
  "agents:collaborationSessionRuntime"

export type CollaborationSessionRuntimeMode = "supervisor" | "group"

export type CollaborationSessionState =
  | "idle"
  | "planning"
  | "executing"
  | "waiting_input"
  | "waiting_approval"
  | "synthesizing"
  | "completed"
  | "failed"
  | "cancelled"

const VALID_SESSION_STATES: readonly CollaborationSessionState[] = [
  "idle", "planning", "executing", "waiting_input",
  "waiting_approval", "synthesizing", "completed", "failed", "cancelled"
]

function isValidSessionState(value: string | undefined): value is CollaborationSessionState {
  return !!value && VALID_SESSION_STATES.includes(value as CollaborationSessionState)
}

export interface CollaborationSessionParticipantInput {
  conversationId: string
  agentId: string
  role?: string
  status?: string
}

export interface CollaborationSessionParticipant {
  id: string
  session_id: string
  conversation_id: string
  agent_id: string
  role: string
  status: string
}

export interface CollaborationSession {
  id: string
  chat_id: string
  workspace_id: string | null
  project_id: string | null
  mode: CollaborationSessionRuntimeMode
  state: CollaborationSessionState
  goal: string | null
  active_plan_revision: string | null
}

export interface CollaborationSessionDetail extends CollaborationSession {
  participants: CollaborationSessionParticipant[]
}

// Event payload types - discriminated union based on event type
export type TaskEventPayload = {
  nodeId?: string
  task?: string
  error?: string
  resultPath?: string
  status?: string
  agent?: string
}

export type PlanRevisionPayload = {
  revision?: number
}

export type ApprovalPayload = {
  kind?: string
  status?: string
}

export type DagEventPayload = {
  submittedNodes?: number
  failed?: number
  completed?: number
  summary?: string
  status?: string
}

export type SessionStatePayload = {
  from?: string
  to?: string
  status?: string
}

export type CollaborationEventPayload =
  | TaskEventPayload
  | PlanRevisionPayload
  | ApprovalPayload
  | DagEventPayload
  | SessionStatePayload
  | Record<string, unknown>

export interface CollaborationContextEvent {
  id: string
  session_id: string
  sequence: number
  type: string
  actor_type: string
  actor_id: string | null
  payload: CollaborationEventPayload
  visibility: string
  artifact_refs: string[]
}

export interface CollaborationInteractionResult extends CollaborationSessionDetail {
  event_id?: string | null
  event_sequence?: number | null
  route?: "auto" | "lightweight" | "collaboration"
}

export interface SubmitCollaborationInteractionInput {
  text: string
  kind?: "goal" | "message" | "input" | "artifact"
  mentionedAgentIds?: string[]
  selectedAgentIds?: string[]
  constraints?: string[]
  artifactRefs?: string[]
  metadata?: Record<string, unknown>
}

export function isCollaborationSessionRuntimeEnabled(): boolean {
  if (typeof window === "undefined") return false
  return window.localStorage.getItem(COLLABORATION_SESSION_FLAG_KEY) !== "false"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function normalizeSession(value: unknown): CollaborationSession | null {
  if (!isRecord(value)) return null
  const id = readString(value.id)
  const chatId = readString(value.chat_id)
  const mode = readString(value.mode)
  const state = readString(value.state)
  if (!id || !chatId || (mode !== "supervisor" && mode !== "group") || !state) {
    return null
  }

  // Validate state is a valid CollaborationSessionState
  if (!isValidSessionState(state)) {
    return null
  }

  return {
    id,
    chat_id: chatId,
    workspace_id: readString(value.workspace_id) ?? null,
    project_id: readString(value.project_id) ?? null,
    mode,
    state: state as CollaborationSessionState,
    goal: readString(value.goal) ?? null,
    active_plan_revision: readString(value.active_plan_revision) ?? null,
  }
}

function normalizeDetail(value: unknown): CollaborationSessionDetail | null {
  const session = normalizeSession(value)
  if (!session) return null
  const participants = isRecord(value) && Array.isArray(value.participants)
    ? value.participants.filter(isRecord).map((participant) => ({
      id: readString(participant.id) ?? "",
      session_id: readString(participant.session_id) ?? session.id,
      conversation_id: readString(participant.conversation_id) ?? "",
      agent_id: readString(participant.agent_id) ?? "",
      role: readString(participant.role) ?? "peer",
      status: readString(participant.status) ?? "ready",
    })).filter((participant) => participant.id && participant.agent_id)
    : []

  return { ...session, participants }
}

function normalizeEvent(value: unknown): CollaborationContextEvent | null {
  if (!isRecord(value)) return null
  const id = readString(value.id)
  const sessionId = readString(value.session_id)
  const type = readString(value.type)
  if (!id || !sessionId || !type || typeof value.sequence !== "number") {
    return null
  }

  return {
    id,
    session_id: sessionId,
    sequence: value.sequence,
    type,
    actor_type: readString(value.actor_type) ?? "system",
    actor_id: readString(value.actor_id) ?? null,
    payload: isRecord(value.payload) ? value.payload : {},
    visibility: readString(value.visibility) ?? "shared",
    artifact_refs: Array.isArray(value.artifact_refs)
      ? value.artifact_refs.filter(readString).map((item) => item as string)
      : [],
  }
}

function mergeEvents(
  current: CollaborationContextEvent[],
  incoming: CollaborationContextEvent[],
): CollaborationContextEvent[] {
  const byId = new Map(current.map((event) => [event.id, event]))
  for (const event of incoming) byId.set(event.id, event)
  return Array.from(byId.values()).sort((a, b) => a.sequence - b.sequence)
}

interface UseCollaborationSessionInput {
  chatId: string
  conversationId: string
  mode: CollaborationSessionRuntimeMode
  workspaceId?: string | null
  projectId?: string | null
  participants: CollaborationSessionParticipantInput[]
  enabled: boolean
  pollingEnabled: boolean
}

export function useCollaborationSession({
  chatId,
  conversationId,
  mode,
  workspaceId,
  projectId,
  participants,
  enabled,
  pollingEnabled,
}: UseCollaborationSessionInput) {
  const [session, setSession] = useState<CollaborationSessionDetail | null>(null)
  const [events, setEvents] = useState<CollaborationContextEvent[]>([])
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const lastSequenceRef = useRef(0)

  const loadEvents = useCallback(async (sessionId: string, reset = false) => {
    const after = reset ? 0 : lastSequenceRef.current
    const rawEvents = await trpcClient.ergatai.listCollaborationSessionEvents.query({
      sessionId,
      after,
      limit: 200,
    })
    const normalized = rawEvents
      .map(normalizeEvent)
      .filter((event): event is CollaborationContextEvent => event !== null)
    if (normalized.length === 0) return

    lastSequenceRef.current = Math.max(
      lastSequenceRef.current,
      ...normalized.map((event) => event.sequence),
    )
    setEvents((current) => reset
      ? normalized
      : mergeEvents(current, normalized))

    for (const event of [...normalized].reverse()) {
      if (event.type !== "session_state_changed") continue
      // Type guard: check if payload has the expected structure
      const payload = event.payload as SessionStatePayload
      const nextState = readString(payload.to)
      if (!nextState) continue

      // Validate nextState is a valid CollaborationSessionState
      if (!isValidSessionState(nextState)) continue

      setSession((current) => current
        ? { ...current, state: nextState as CollaborationSessionState }
        : current)
      break
    }
  }, [])

  const refreshSession = useCallback(async () => {
    const existing = await trpcClient.ergatai.findCollaborationSessionByChat.query({
      chatId,
    })
    if (!existing) return null

    const detail = normalizeDetail(existing)
    if (!detail) throw new Error("Invalid collaboration session response")
    if (detail.mode !== mode) {
      throw new Error(`Chat session is in ${detail.mode} mode, expected ${mode}`)
    }

    setSession(detail)
    setError(null)
    return detail
  }, [chatId, mode])

  const loadExistingSession = useCallback(async () => {
    const detail = await refreshSession()
    if (!detail) return null

    await loadEvents(detail.id, true)
    return detail
  }, [loadEvents, refreshSession])

  const ensureSession = useCallback(async () => {
    const created = await trpcClient.ergatai.createCollaborationSession.mutate({
      chatId,
      workspaceId: workspaceId || undefined,
      projectId: projectId || undefined,
      mode,
      participants,
    })
    const detail = normalizeDetail(created)
    if (!detail) throw new Error("Invalid collaboration session response")
    setSession(detail)
    setError(null)
    await loadEvents(detail.id, true)
    return detail
  }, [
    chatId,
    loadEvents,
    mode,
    participants,
    projectId,
    workspaceId,
  ])

  const submitInteraction = useCallback(
    async (input: SubmitCollaborationInteractionInput) => {
      setIsSubmitting(true)
      try {
        const currentSession = await ensureSession()
        const rawResult = await trpcClient.ergatai.submitCollaborationSessionInteraction.mutate({
          sessionId: currentSession.id,
          text: input.text,
          kind: input.kind ?? "message",
          mentionedAgentIds: input.mentionedAgentIds ?? [],
          selectedAgentIds: input.selectedAgentIds ?? [],
          constraints: input.constraints ?? [],
          artifactRefs: input.artifactRefs ?? [],
          metadata: {
            conversationId,
            ...(input.metadata ?? {}),
          },
          route: "auto",
          autoExecute: true,
        })

        // Normalize the result and ensure it has the expected structure
        const result: CollaborationInteractionResult = normalizeDetail(rawResult)
          ? { ...rawResult, route: rawResult.route ?? "auto" }
          : { ...rawResult, route: "auto" }

        const detail = normalizeDetail(result)
        if (detail) setSession(detail)
        await loadEvents(currentSession.id)
        setError(null)
        return result
      } finally {
        setIsSubmitting(false)
      }
    },
    [conversationId, ensureSession, loadEvents],
  )

  useEffect(() => {
    if (!enabled || !chatId) return

    // 重置序列号，防止旧会话的高序列号污染新会话
    // Reset sequence number to prevent high sequence numbers from old session
    // from polluting the new session and causing events to be skipped
    lastSequenceRef.current = 0

    let cancelled = false

    void loadExistingSession().catch((caught: unknown) => {
      if (cancelled) return
      log.debug("Runtime unavailable", caught as Error)
      setError(caught instanceof Error ? caught.message : "Collaboration runtime unavailable")
    })

    return () => {
      cancelled = true
    }
  }, [chatId, enabled, loadExistingSession])

  useEffect(() => {
    if (!pollingEnabled || !enabled || !session) return

    let isActive = true
    let timeoutId: number | undefined

    const poll = async () => {
      if (!isActive) return

      try {
        await refreshSession()
        await loadEvents(session.id)
      } catch (caught: unknown) {
        log.debug("Event poll failed", caught as Error)
      }

      // Schedule next poll only after current one completes
      if (isActive) {
        timeoutId = window.setTimeout(poll, 1000)
      }
    }

    // Start polling
    timeoutId = window.setTimeout(poll, 1000)

    return () => {
      isActive = false
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, loadEvents, pollingEnabled, refreshSession])

  const sessionEvents = useMemo(() => {
    if (!session) return []
    return events.filter((event) => event.session_id === session.id)
  }, [events, session])

  return {
    session,
    events: sessionEvents,
    error,
    isSubmitting,
    ensureSession,
    refreshSession,
    submitInteraction,
  }
}
