import { useMemo } from "react"
import { FileLock2, LayoutDashboard, MessageSquare } from "lucide-react"

import { trpc } from "../../../lib/trpc"
import { Badge } from "../../../components/ui/badge"
import { Progress } from "../../../components/ui/progress"
import { Skeleton } from "../../../components/ui/skeleton"
import { cn } from "../../../lib/utils"

type LockInfo = {
  id: string
  file_path: string
  agent_id: string
  mode: string
  status: string
}

type LockContention = {
  file_path: string
  current_holder: string | null
  waiting_agents: string[]
  wait_time_secs: number
  conflict_count: number
}

type MessageTypeStats = {
  message_type: string
  count: number
  percentage: number
}

type SystemConfig = {
  nats_initialized: boolean
  nats_port: number | null
  active_agents: number
}

function LockRow({ lock }: { lock: LockInfo }) {
  const isActive = lock.status.toLowerCase() === "active"
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 text-xs">
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          isActive ? "bg-emerald-500" : "bg-muted-foreground/40",
        )}
      />
      <span className="truncate font-mono text-foreground/90">{lock.file_path}</span>
      <span className="ml-auto shrink-0 text-muted-foreground">{lock.agent_id}</span>
      <Badge variant="outline" className="shrink-0 text-[10px]">
        {lock.mode}
      </Badge>
    </div>
  )
}

function ContentionRow({ contention }: { contention: LockContention }) {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 text-xs">
      <span className="size-1.5 shrink-0 rounded-full bg-amber-500" />
      <span className="truncate font-mono text-foreground/90">{contention.file_path}</span>
      <span className="ml-auto shrink-0 text-muted-foreground">
        {contention.waiting_agents.length} waiting · {contention.wait_time_secs}s
      </span>
    </div>
  )
}

function StatBar({ stat }: { stat: MessageTypeStats }) {
  return (
    <div className="px-3 py-1.5 text-xs">
      <div className="flex items-center justify-between">
        <span className="font-medium">{stat.message_type}</span>
        <span className="text-muted-foreground">{stat.count}</span>
      </div>
      <Progress value={stat.percentage} className="mt-1 h-1" />
    </div>
  )
}

export function MonitoringPanel({ className }: { className?: string }) {
  const locks = trpc.ergatai.listLocks.useQuery(undefined, {
    refetchInterval: 5_000,
  })
  const contention = trpc.ergatai.getLockContention.useQuery(undefined, {
    refetchInterval: 5_000,
  })
  const systemConfig = trpc.ergatai.getSystemConfig.useQuery()

  const activeLocks = useMemo(
    () => (locks.data ?? []).filter((l) => l.status.toLowerCase() === "active"),
    [locks.data],
  )

  if (locks.isLoading && contention.isLoading) {
    return (
      <div className={cn("space-y-3 p-3", className)}>
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-16 w-full" />
      </div>
    )
  }

  return (
    <div className={cn("space-y-4", className)}>
      <section>
        <div className="flex items-center gap-1.5 px-1 pb-1.5 text-xs font-medium text-muted-foreground">
          <FileLock2 className="size-3.5" />
          File Locks
          <Badge variant="secondary" className="ml-auto text-[10px]">
            {activeLocks.length} active
          </Badge>
        </div>
        {activeLocks.length === 0 ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">No active locks</p>
        ) : (
          <div className="rounded-md border">
            {activeLocks.map((lock) => (
              <LockRow key={lock.id} lock={lock} />
            ))}
          </div>
        )}
      </section>

      {contention.data && contention.data.length > 0 && (
        <section>
          <div className="flex items-center gap-1.5 px-1 pb-1.5 text-xs font-medium text-muted-foreground">
            <FileLock2 className="size-3.5 text-amber-500" />
            Contention
          </div>
          <div className="rounded-md border border-amber-500/30 bg-amber-500/5">
            {contention.data.map((c) => (
              <ContentionRow key={c.file_path} contention={c} />
            ))}
          </div>
        </section>
      )}

      {systemConfig.data && (
        <section>
          <div className="flex items-center gap-1.5 px-1 pb-1.5 text-xs font-medium text-muted-foreground">
            <LayoutDashboard className="size-3.5" />
            System
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-md border px-2 py-1.5 text-center">
              <div className="text-sm font-semibold">{systemConfig.data.active_agents}</div>
              <div className="text-[10px] text-muted-foreground">Agents</div>
            </div>
            <div className="rounded-md border px-2 py-1.5 text-center">
              <div className="text-sm font-semibold">
                {systemConfig.data.nats_initialized ? "Yes" : "No"}
              </div>
              <div className="text-[10px] text-muted-foreground">NATS</div>
            </div>
            <div className="rounded-md border px-2 py-1.5 text-center">
              <div className="text-sm font-semibold">
                {systemConfig.data.nats_port ?? "—"}
              </div>
              <div className="text-[10px] text-muted-foreground">Port</div>
            </div>
          </div>
        </section>
      )}
    </div>
  )
}
