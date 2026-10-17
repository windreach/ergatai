"use client"

import { memo, useMemo } from "react"
import {
  Bot,
  CheckCircle2,
  CircleDashed,
  GitBranch,
  ListTree,
  Loader2,
  ShieldAlert,
  ShieldCheck,
  XCircle,
} from "lucide-react"

import { cn } from "../../../lib/utils"
import type {
  CollaborationContextEvent,
  CollaborationSessionDetail,
} from "./collaboration-session-runtime"

type EventStatus = "pending" | "running" | "completed" | "failed" | "neutral"

const STATUS_CONFIG: Record<
  EventStatus,
  { icon: typeof Bot; label: string; className: string }
> = {
  pending: {
    icon: CircleDashed,
    label: "Pending",
    className: "text-muted-foreground",
  },
  running: {
    icon: Loader2,
    label: "Running",
    className: "text-amber-500",
  },
  completed: {
    icon: CheckCircle2,
    label: "Completed",
    className: "text-emerald-500",
  },
  failed: {
    icon: XCircle,
    label: "Failed",
    className: "text-red-500",
  },
  neutral: {
    icon: ListTree,
    label: "Update",
    className: "text-muted-foreground",
  },
}

const SEMANTIC_EVENT_TYPES = new Set([
  "approval_granted",
  "approval_rejected",
  "approval_required",
  "dag_completed",
  "dag_failed",
  "dag_recovered",
  "plan_hot_swapped",
  "plan_activated",
  "plan_revision_created",
  "session_state_changed",
  "task_completed",
  "task_failed",
  "task_skipped",
  "task_started",
])

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined
}

function eventStatus(event: CollaborationContextEvent): EventStatus {
  const payload = event.payload as Record<string, unknown>
  const payloadStatus = readString(payload.status)

  if (
    event.type === "task_started" ||
    event.type === "plan_hot_swapped" ||
    event.type === "plan_activated" ||
    event.type === "dag_recovered"
  ) {
    return "running"
  }
  if (
    event.type === "task_completed" ||
    event.type === "dag_completed" ||
    event.type === "approval_granted"
  ) {
    return "completed"
  }
  if (event.type === "task_failed" || event.type === "dag_failed") {
    return "failed"
  }
  if (event.type === "approval_rejected") return "failed"
  if (event.type === "approval_required") return "pending"
  if (payloadStatus === "running") return "running"
  if (payloadStatus === "completed") return "completed"
  if (payloadStatus === "failed") return "failed"
  return "neutral"
}

function eventTitle(event: CollaborationContextEvent): string {
  const payload = event.payload as Record<string, unknown>
  const nodeId = readString(payload.nodeId)
  switch (event.type) {
    case "plan_revision_created":
      return `Plan revision ${readNumber(payload.revision) ?? ""}`.trim()
    case "plan_activated":
      return "Plan activated"
    case "plan_hot_swapped":
      return "Plan hot-swapped"
    case "task_started":
    case "task_completed":
    case "task_failed":
    case "task_skipped":
      return nodeId ?? "Task update"
    case "approval_required":
      return "Approval required"
    case "approval_granted":
      return "Approval granted"
    case "approval_rejected":
      return "Approval rejected"
    case "dag_completed":
      return "DAG completed"
    case "dag_failed":
      return "DAG failed"
    case "dag_recovered":
      return "DAG recovered"
    case "session_state_changed":
      return `Session ${readString(payload.to) ?? "state changed"}`
    default:
      return "Runtime update"
  }
}

function eventSummary(event: CollaborationContextEvent): string {
  const payload = event.payload as Record<string, unknown>
  const task = readString(payload.task)
  const summary = readString(payload.summary)
  const error = readString(payload.error)
  const reason = readString(payload.reason)
  const resultPath = readString(payload.resultPath)
  const submittedNodes = readNumber(payload.submittedNodes)
  const failedNodes = readNumber(payload.failed)
  const completedNodes = readNumber(payload.completed)
  const kind = readString(payload.kind)
  const from = readString(payload.from)
  const to = readString(payload.to)

  if (error) return error
  if (task) return task
  if (summary) return summary
  if (resultPath) return `Result: ${resultPath}`
  if (submittedNodes !== undefined) {
    return `${submittedNodes} node${submittedNodes === 1 ? "" : "s"} submitted`
  }
  if (failedNodes !== undefined) return `${failedNodes} node(s) failed`
  if (completedNodes !== undefined) return `${completedNodes} node(s) completed`
  if (kind) return `Approval kind: ${kind}`
  if (from && to) return `${from} → ${to}`
  if (reason) return reason
  return "Collaboration runtime update"
}

interface CollaborationSessionEventCardsProps {
  className?: string
  events: CollaborationContextEvent[]
  session: CollaborationSessionDetail | null
}

export const CollaborationSessionEventCards = memo(
  function CollaborationSessionEventCards({
    className,
    events,
    session,
  }: CollaborationSessionEventCardsProps) {
    const semanticEvents = useMemo(
      () => events
        .filter((event) => SEMANTIC_EVENT_TYPES.has(event.type))
        .slice(-12),
      [events],
    )

    if (!session && semanticEvents.length === 0) return null

    return (
      <div className={cn("mx-auto mb-4 w-full max-w-2xl space-y-2", className)}>
        {session && session.participants.length > 0 && (
          <div className="rounded-xl border bg-card/70 px-3 py-2 shadow-sm">
            <div className="flex items-center gap-2">
              <GitBranch className="h-4 w-4 shrink-0 text-muted-foreground" />
              <p className="min-w-0 flex-1 truncate text-sm font-medium">
                Collaboration session
              </p>
              <span className="shrink-0 text-[11px] text-muted-foreground">
                {session.state?.replace("_", " ") ?? "unknown"}
              </span>
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              {session.participants.map((participant) => (
                <span
                  key={participant.id}
                  className="inline-flex h-6 items-center gap-1 rounded-full bg-muted px-2 text-[11px] text-muted-foreground"
                >
                  <Bot className="h-3 w-3" />
                  {participant.agent_id}
                  <span className="opacity-70">· {participant.status}</span>
                </span>
              ))}
            </div>
          </div>
        )}

        {semanticEvents.map((event) => {
          const status = eventStatus(event)
          const config = STATUS_CONFIG[status]
          const StatusIcon = config.icon
          const payload = event.payload as Record<string, unknown>
          const agent = readString(payload.agent) ?? event.actor_id

          return (
            <div
              key={event.id}
              className="rounded-xl border bg-card/70 px-3 py-2 shadow-sm"
            >
              <div className="flex min-w-0 items-center gap-2">
                <StatusIcon
                  className={cn(
                    "h-4 w-4 shrink-0",
                    config.className,
                    status === "running" && "animate-spin",
                  )}
                />
                <p className="min-w-0 flex-1 truncate text-sm font-medium">
                  {eventTitle(event)}
                </p>
                <span
                  className={cn("shrink-0 text-[11px]", config.className)}
                >
                  {config.label}
                </span>
              </div>
              <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                {eventSummary(event)}
              </p>
              {(agent || event.artifact_refs.length > 0) && (
                <div className="mt-2 flex flex-wrap items-center gap-1">
                  {agent && (
                    <span className="inline-flex h-6 items-center gap-1 rounded-full bg-muted px-2 text-[11px] text-muted-foreground">
                      <Bot className="h-3 w-3" />
                      {agent}
                    </span>
                  )}
                  {event.artifact_refs.map((artifact) => (
                    <span
                      key={artifact}
                      className="max-w-full truncate rounded-full bg-muted px-2 py-1 text-[11px] text-muted-foreground"
                    >
                      {artifact}
                    </span>
                  ))}
                </div>
              )}
              {event.type === "approval_required" && (
                <div className="mt-2 flex items-center gap-1 text-[11px] text-amber-600">
                  <ShieldAlert className="h-3 w-3" />
                  Waiting for approval
                </div>
              )}
              {event.type === "approval_granted" && (
                <div className="mt-2 flex items-center gap-1 text-[11px] text-emerald-600">
                  <ShieldCheck className="h-3 w-3" />
                  Approved
                </div>
              )}
            </div>
          )
        })}
      </div>
    )
  },
)
