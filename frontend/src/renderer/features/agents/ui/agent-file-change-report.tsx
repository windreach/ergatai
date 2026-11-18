"use client"

import { useState } from "react"
import { ChevronDown, ChevronRight, FileText } from "lucide-react"
import { cn } from "../../../lib/utils"

interface FileChangeEntry {
  path?: string
  file?: string
  filename?: string
  status?: string
  kind?: string
  type?: string
}

function extractFiles(payload: unknown): FileChangeEntry[] {
  if (!payload || typeof payload !== "object") return []
  const obj = payload as Record<string, unknown>
  const candidates = [
    obj.files,
    obj.changes,
    obj.fileChanges,
    obj.file_changes,
    obj.changedFiles,
    obj.changed_files,
  ]
  for (const c of candidates) {
    if (Array.isArray(c)) {
      return c.map((item) => {
        if (typeof item === "string") return { path: item }
        if (item && typeof item === "object") return item as FileChangeEntry
        return {}
      })
    }
  }
  return []
}

export function AgentFileChangeReport({ payload }: { payload?: unknown }) {
  const [open, setOpen] = useState(false)
  const files = extractFiles(payload)
  const hasFiles = files.length > 0

  return (
    <div className="my-2 rounded-lg border border-border/60 bg-muted/30 p-3 text-sm">
      <button
        type="button"
        className="flex w-full items-center gap-2 text-left font-medium"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        <FileText className="h-4 w-4" />
        <span>文件变更摘要</span>
        {hasFiles ? <span className="text-muted-foreground">({files.length})</span> : null}
      </button>
      {open ? (
        <div className="mt-2 space-y-1 pl-6">
          {hasFiles ? (
            files.map((f) => {
              const path = f.path || f.file || f.filename || ""
              const status = f.status || f.kind || f.type || ""
              return (
                <div key={path || JSON.stringify(f)} className="flex items-center gap-2 text-xs">
                  {status ? (
                    <span className={cn("rounded px-1.5 py-0.5 text-[10px] uppercase", "bg-background/60")}>
                      {status}
                    </span>
                  ) : null}
                  <span className="truncate font-mono">{path || JSON.stringify(f)}</span>
                </div>
              )
            })
          ) : (
            <pre className="max-h-64 overflow-auto rounded bg-background/60 p-2 text-xs">
              {JSON.stringify(payload ?? {}, null, 2)}
            </pre>
          )}
        </div>
      ) : null}
    </div>
  )
}
