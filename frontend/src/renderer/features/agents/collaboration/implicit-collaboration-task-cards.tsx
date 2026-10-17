"use client"

import { memo } from "react"
import {
  Bot,
  CheckCircle2,
  CircleDashed,
  Loader2,
  XCircle,
} from "lucide-react"

import { cn } from "../../../lib/utils"
import type {
  ImplicitCollaborationStatus,
  ImplicitCollaborationTask,
} from "./implicit-collaboration"

const STATUS_CONFIG: Record<
  ImplicitCollaborationStatus,
  { label: string; icon: typeof Bot; className: string }
> = {
  pending: {
    label: "Pending",
    icon: CircleDashed,
    className: "text-muted-foreground",
  },
  running: {
    label: "Running",
    icon: Loader2,
    className: "text-amber-500",
  },
  completed: {
    label: "Completed",
    icon: CheckCircle2,
    className: "text-emerald-500",
  },
  failed: {
    label: "Failed",
    icon: XCircle,
    className: "text-red-500",
  },
}

interface ImplicitCollaborationTaskCardsProps {
  className?: string
  tasks: ImplicitCollaborationTask[]
}

export const ImplicitCollaborationTaskCards = memo(
  function ImplicitCollaborationTaskCards({
    className,
    tasks,
  }: ImplicitCollaborationTaskCardsProps) {
    if (tasks.length === 0) return null

    return (
      <div className={cn("mx-auto mb-4 w-full max-w-2xl space-y-2", className)}>
        {tasks.map((task) => {
          const StatusIcon = STATUS_CONFIG[task.status].icon

          return (
            <div
              key={task.id}
              className="rounded-xl border bg-card/70 px-3 py-2 shadow-sm"
            >
              <div className="flex min-w-0 items-center gap-2">
                <StatusIcon
                  className={cn(
                    "h-4 w-4 shrink-0",
                    STATUS_CONFIG[task.status].className,
                    task.status === "running" && "animate-spin",
                  )}
                />
                <p className="min-w-0 flex-1 truncate text-sm font-medium">
                  {task.title}
                </p>
                <span
                  className={cn(
                    "shrink-0 text-[11px] text-muted-foreground",
                    STATUS_CONFIG[task.status].className,
                  )}
                >
                  {STATUS_CONFIG[task.status].label}
                </span>
              </div>

              <p className="mt-1 truncate text-xs text-muted-foreground">
                {task.summary}
              </p>

              {task.agents.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {task.agents.map((agentId) => (
                    <span
                      key={agentId}
                      className="inline-flex h-6 items-center gap-1 rounded-full bg-muted px-2 text-[11px] text-muted-foreground"
                    >
                      <Bot className="h-3 w-3" />
                      {agentId}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    )
  },
)
