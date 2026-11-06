"use client"

import { useState } from "react"
import { trpc } from "../lib/trpc"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./ui/dialog"
import { Button } from "./ui/button"

export function HelpGuideWidget() {
  const [open, setOpen] = useState(false)
  const utils = trpc.useUtils()
  const runMigration = trpc.ergatai.runMigration.useMutation()
  const profilesQuery = trpc.ergatai.listProfilesWithStatus.useQuery()

  const installedAgents = (profilesQuery.data?.profiles ?? [])
    .filter((p: any) => p.installed)
    .map((p: any) => p.name as string)

  const agentNames = installedAgents.length > 0 ? installedAgents.join("、") : "暂无已安装 Agent"

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          className="flex items-center justify-center h-7 w-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-[background-color,color,transform] duration-150 ease-out active:scale-[0.97] outline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring/70"
          aria-label="Help"
        >
          <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="8" cy="8" r="6.5" />
            <path d="M6.2 6.2a1.8 1.8 0 0 1 3.3 1c0 1.2-1.5 1.5-1.5 2.5" />
            <circle cx="8" cy="11.5" r="0.5" fill="currentColor" stroke="none" />
          </svg>
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>迁移提示</DialogTitle>
          <DialogDescription>
            检测到本地已经安装 {agentNames}，是否需要进行迁移？
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            稍后
          </Button>
          <Button
            disabled={runMigration.isPending || installedAgents.length === 0}
            onClick={() => {
              console.log("runMigration: triggering")
              runMigration.mutate(undefined, {
                onSuccess: (data) => {
                  console.log("runMigration: success", data)
                  // Invalidate progress query so the widget starts polling immediately
                  utils.ergatai.getMigrationProgress.invalidate()
                },
                onError: (err) => console.error("runMigration: failed", err),
              })
              setOpen(false)
            }}
          >
            {runMigration.isPending ? "迁移中…" : "开始迁移"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}