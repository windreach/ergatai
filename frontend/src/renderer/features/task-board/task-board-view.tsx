import { memo, useCallback, useEffect, useState } from "react"
import {
  ArrowLeft,
  CheckCircle2,
  CircleDot,
  Clock,
  Plus,
  XCircle,
} from "lucide-react"

import { Button } from "../../components/ui/button"
import { Textarea } from "../../components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog"
import { toast } from "sonner"
import { cn } from "../../lib/utils"
import {
  taskBoardContractApi,
  type AgentActivity,
  type BoardTask,
  type TaskBoardStatus,
} from "./lib/task-board-contract-api"

const STATUS_META: Record<
  TaskBoardStatus,
  {
    label: string
    icon: typeof Clock
    badge: string
    column: string
    header: string
  }
> = {
  queued: {
    label: "Queued",
    icon: Clock,
    badge: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
    column: "border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-900/40",
    header: "text-slate-600 dark:text-slate-300",
  },
  running: {
    label: "Running",
    icon: CircleDot,
    badge: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
    column: "border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/25",
    header: "text-amber-700 dark:text-amber-300",
  },
  completed: {
    label: "Completed",
    icon: CheckCircle2,
    badge: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
    column: "border-emerald-200 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/25",
    header: "text-emerald-700 dark:text-emerald-300",
  },
  failed: {
    label: "Failed",
    icon: XCircle,
    badge: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
    column: "border-rose-200 bg-rose-50 dark:border-rose-800 dark:bg-rose-950/25",
    header: "text-rose-700 dark:text-rose-300",
  },
}

const BOARD_COLUMNS: TaskBoardStatus[] = [
  "queued",
  "running",
  "completed",
  "failed",
]

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value))
}

function formatRunTime(value: string) {
  const minutes = Math.max(
    0,
    Math.floor((Date.now() - new Date(value).getTime()) / 60000),
  )

  if (minutes < 1) return "Just started"
  if (minutes < 60) return `${minutes}m`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`

  const days = Math.floor(hours / 24)
  return `${days}d ${hours % 24}h`
}

function TaskStatusBadge({ status }: { status: TaskBoardStatus }) {
  const meta = STATUS_META[status]
  const Icon = meta.icon

  return (
    <span
      className={cn(
        "inline-flex flex-shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
        meta.badge,
      )}
    >
      <Icon className="h-3 w-3" />
      {meta.label}
    </span>
  )
}

function ActivityLogo({ activity }: { activity: AgentActivity }) {
  return (
    <span
      className={cn(
        "flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-[10px] font-semibold",
        activity.logoKind === "claude-code"
          ? "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300"
          : "bg-primary/10 text-primary",
      )}
    >
      {activity.logoText}
    </span>
  )
}

const AgentActivityCard = memo(function AgentActivityCard({
  activity,
}: {
  activity: AgentActivity
}) {
  const meta = STATUS_META[activity.status]
  const Icon = meta.icon

  return (
    <article className="flex flex-col rounded-xl border bg-card p-3 shadow-sm">
      <div className="flex items-center gap-2">
        <ActivityLogo activity={activity} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {activity.agentName}
        </span>
      </div>

      <div className="mt-3 rounded-lg border border-border/60 bg-muted/40 p-2">
        <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Running task
        </p>
        <p className="mt-1 line-clamp-2 text-sm leading-snug">
          {activity.subtaskTitle}
        </p>
      </div>

      <div className="mt-3 flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="truncate">{formatRunTime(activity.startedAt)}</span>
        <span
          className={cn(
            "inline-flex flex-shrink-0 items-center gap-1 rounded-full px-2 py-0.5",
            meta.badge,
          )}
        >
          <Icon className="h-3 w-3" />
          {meta.label}
        </span>
      </div>
    </article>
  )
})

const TaskCard = memo(function TaskCard({
  task,
  onClick,
}: {
  task: BoardTask
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-40 flex-col rounded-xl border bg-card p-4 text-left shadow-sm transition hover:border-primary/50 hover:shadow-md"
    >
      <div className="flex items-start justify-between gap-3">
        <h2 className="line-clamp-2 text-sm font-semibold">{task.title}</h2>
        <TaskStatusBadge status={task.status} />
      </div>
      <p className="mt-2 truncate text-sm text-muted-foreground">
        {task.workspaceName}
      </p>
      <div className="mt-auto flex items-center justify-between pt-3 text-xs text-muted-foreground">
        <span>{formatDateTime(task.startedAt)}</span>
        <span>Execution status</span>
      </div>
    </button>
  )
})

function TaskActivityBoard({
  taskId,
  onBack,
}: {
  taskId: string
  onBack: () => void
}) {
  const [task, setTask] = useState<BoardTask | null>(null)
  const [activities, setActivities] = useState<AgentActivity[]>([])

  useEffect(() => {
    let cancelled = false

    taskBoardContractApi.getTask(taskId).then((result) => {
      if (!cancelled) setTask(result)
    })
    taskBoardContractApi.listActivities(taskId).then((result) => {
      if (!cancelled) setActivities(result)
    })

    return () => {
      cancelled = true
    }
  }, [taskId])

  if (!task) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading task...
      </div>
    )
  }

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden bg-background">
      <header className="flex flex-shrink-0 items-center gap-3 border-b px-5 py-4">
        <Button variant="ghost" size="icon" onClick={onBack} aria-label="Back to Task Board">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold">{task.title}</h1>
          <p className="truncate text-sm text-muted-foreground">
            {task.workspaceName} · Agent activity by status
          </p>
        </div>
        <div className="ml-auto flex-shrink-0">
          <TaskStatusBadge status={task.status} />
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-hidden p-4">
        <div className="grid h-full grid-cols-2 gap-4 xl:grid-cols-4">
          {BOARD_COLUMNS.map((status) => {
            const meta = STATUS_META[status]
            const columnActivities = activities.filter(
              (activity) => activity.status === status,
            )

            return (
              <section
                key={status}
                className={cn(
                  "flex min-h-0 flex-col rounded-2xl border p-3",
                  meta.column,
                )}
              >
                <header className="flex flex-shrink-0 items-center justify-center gap-2">
                  <h2 className={cn("text-sm font-semibold", meta.header)}>
                    {meta.label}
                  </h2>
                  <span className="rounded-full bg-card px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    {columnActivities.length}
                  </span>
                </header>

                <div className="mt-3 min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
                  {columnActivities.map((activity) => (
                    <AgentActivityCard key={activity.id} activity={activity} />
                  ))}
                </div>
              </section>
            )
          })}
        </div>
      </main>
    </div>
  )
}

export function TaskBoardView() {
  const [tasks, setTasks] = useState<BoardTask[]>([])
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isCreating, setIsCreating] = useState(false)
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [dagDefinition, setDagDefinition] = useState("")
  const [validationResult, setValidationResult] = useState<{ valid: boolean; errors: string[]; warnings: string[] } | null>(null)

  const loadTasks = useCallback(async () => {
    const result = await taskBoardContractApi.listTasks()
    setTasks(result)
    setIsLoading(false)
  }, [])

  useEffect(() => {
    void loadTasks()
  }, [loadTasks])

  const handleCreateTask = useCallback(async () => {
    if (!dagDefinition.trim()) {
      toast.error("Please provide a YAML DAG definition")
      return
    }
    setIsCreating(true)
    try {
      await taskBoardContractApi.createTask({ definition: dagDefinition })
      setCreateDialogOpen(false)
      setDagDefinition("")
      await loadTasks()
    } catch (error) {
      toast.error("Failed to create task", {
        description: error instanceof Error ? error.message : "Unknown error",
      })
    } finally {
      setIsCreating(false)
    }
  }, [loadTasks, dagDefinition])

  const handleValidate = useCallback(async () => {
    if (!dagDefinition.trim()) return
    const result = await taskBoardContractApi.validateTask(dagDefinition)
    setValidationResult(result)
  }, [dagDefinition])

  if (selectedTaskId) {
    return (
      <TaskActivityBoard
        taskId={selectedTaskId}
        onBack={() => setSelectedTaskId(null)}
      />
    )
  }

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden bg-background">
      <header className="flex flex-shrink-0 flex-wrap items-center gap-3 border-b px-6 py-4">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold">Task Board</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Click a task card below to view details
          </p>
        </div>
        <Button
          className="ml-auto"
          onClick={() => setCreateDialogOpen(true)}
          disabled={isCreating}
        >
          <Plus className="mr-1.5 h-4 w-4" />
          New Task
        </Button>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto p-6">
        {isLoading ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Loading tasks...
          </div>
        ) : tasks.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            No tasks yet
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {tasks.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                onClick={() => setSelectedTaskId(task.id)}
              />
            ))}
          </div>
        )}
      </main>

      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>New Task (DAG)</DialogTitle>
          </DialogHeader>
          <Textarea
            value={dagDefinition}
            onChange={(e) => {
              setDagDefinition(e.target.value)
              setValidationResult(null)
            }}
            placeholder={"# YAML DAG definition\nname: my-pipeline\nnodes:\n  - id: task-1\n    agent: general-purpose\n    task: Describe the task"}
            className="min-h-48 font-mono text-xs"
          />
          {validationResult && !validationResult.valid && validationResult.errors.length > 0 && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {validationResult.errors.map((err, i) => (
                <div key={i}>{err}</div>
              ))}
            </div>
          )}
          {validationResult?.valid && (
            <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-600">
              Definition is valid
            </div>
          )}
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => void handleValidate()}>
              Validate
            </Button>
            <Button onClick={() => void handleCreateTask()} disabled={isCreating}>
              {isCreating ? "Submitting..." : "Submit"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
