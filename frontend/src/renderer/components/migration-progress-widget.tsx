"use client"

import { useState } from "react"
import { trpc } from "../lib/trpc"
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover"
import { Progress } from "./ui/progress"
import { Button } from "./ui/button"

export function MigrationProgressWidget({ inline = false }: { inline?: boolean }) {
  const [open, setOpen] = useState(false)
  const progressQuery = trpc.ergatai.getMigrationProgress.useQuery(undefined, {
    refetchInterval: 5000,
  })

  const migrations = progressQuery.data?.migrations ?? []

  // DEBUG: Log query state
  console.log("[MigrationProgressWidget]", {
    hasData: !!progressQuery.data,
    isLoading: progressQuery.isLoading,
    isFetching: progressQuery.isFetching,
    migrationsCount: migrations.length,
    data: progressQuery.data,
  })

  // Aggregate per agent
  const byAgent = new Map<string, { name: string; total: number; done: number; status: string }>()
  for (const m of migrations) {
    const key = m.agent_id
    const cur = byAgent.get(key) ?? { name: m.agent_name || m.agent_id, total: 0, done: 0, status: m.status }
    cur.total += m.total_sessions
    cur.done += m.processed_sessions
    if (m.status === "running") cur.status = "running"
    byAgent.set(key, cur)
  }

  const rows = Array.from(byAgent.entries()).map(([id, v]) => ({
    id,
    label: v.name,
    total: v.total,
    done: v.done,
    status: v.status,
  }))

  const overall = rows.reduce(
    (acc, m) => ({ total: acc.total + m.total, done: acc.done + m.done }),
    { total: 0, done: 0 },
  )
  const percent = overall.total > 0 ? Math.round((overall.done / overall.total) * 100) : 0

  // Don't render if query failed
  if (progressQuery.error) {
    console.warn("[MigrationProgressWidget] Query error:", progressQuery.error)
    return null
  }

  // Don't render if no data yet (initial load)
  if (!progressQuery.data) return null

  // Don't render if no migrations (even if loading/refetching)
  if (rows.length === 0) return null

  const trigger = (
    <PopoverTrigger asChild>
      {inline ? (
        <button
          type="button"
          className="flex items-center justify-center h-7 w-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-[background-color,color,transform] duration-150 ease-out active:scale-[0.97] outline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring/70"
          aria-label="Migration progress"
        >
          <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M2 12h3V8H2v4Zm4.5 0h3V4h-3v8Zm4.5 0h3V6h-3v6Z" />
          </svg>
        </button>
      ) : (
        <Button
          variant="secondary"
          size="sm"
          className="shadow-lg border border-border/60 bg-background/90 backdrop-blur"
        >
          迁移进度 {percent}%
        </Button>
      )}
    </PopoverTrigger>
  )

  return (
    <div className={inline ? "inline-flex" : "fixed bottom-4 right-4 z-50"}>
      <Popover open={open} onOpenChange={setOpen}>
        {trigger}
        <PopoverContent side="top" align="end" className="w-72 p-3 space-y-3">
          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Agent 历史迁移
          </div>
          <Progress value={percent} className="h-1.5" />
          <div className="space-y-2">
            {rows.map((m) => {
                const p = m.total > 0 ? Math.round((m.done / m.total) * 100) : 0
                return (
                  <div key={m.id} className="space-y-1">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-medium">{m.label}</span>
                      <span className="text-muted-foreground tabular-nums">
                        {m.done}/{m.total}
                      </span>
                    </div>
                    <Progress value={p} className="h-1" />
                    <div className="text-[10px] text-muted-foreground">
                      {m.status === "running"
                        ? "迁移中…"
                        : m.status === "done"
                          ? "已完成"
                          : m.status === "error"
                            ? "失败"
                            : "等待开始"}
                    </div>
                  </div>
                )
              })}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}