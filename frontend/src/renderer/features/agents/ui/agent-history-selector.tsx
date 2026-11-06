"use client"

import { useState } from "react"
import { Popover, PopoverTrigger, PopoverContent } from "../../../components/ui/popover"
import { ClockIcon } from "../../../components/ui/icons"
import { cn } from "../../../lib/utils"
import { trpc } from "../../../lib/trpc"
import { formatTimeAgo } from "../utils/format-time-ago"

/**
 * Shared agent history selector.
 *
 * Used by both the main chat and the side chat through ConversationStatusCard.
 * Clicking the trigger opens an upward-expanding list of conversations.
 */
interface AgentHistorySelectorProps {
  agentId?: string | null
}

interface AgentSession {
  session_id: string
  title: string | null
  created_at: string | null
  updated_at: string | null
}

export function AgentHistorySelector({ agentId }: AgentHistorySelectorProps) {
  const [open, setOpen] = useState(false)
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)

  const sessionsQuery = trpc.ergatai.listAgentSessions.useQuery(
    { agentId: agentId ?? "" },
    { enabled: !!agentId },
  )
  const loadSession = trpc.ergatai.loadAgentSession.useMutation({
    onSuccess: (_data, variables) => {
      void variables
    },
  })

  const sessions: AgentSession[] = Array.isArray(sessionsQuery.data)
    ? (sessionsQuery.data as AgentSession[])
    : Array.isArray((sessionsQuery.data as { sessions?: AgentSession[] } | undefined)?.sessions)
      ? ((sessionsQuery.data as { sessions: AgentSession[] }).sessions)
      : []

  const handleSelect = (sessionId: string) => {
    if (agentId) {
      loadSession.mutate({ agentId, sessionId })
    }
    setActiveSessionId(sessionId)
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          className="flex items-center gap-1.5 h-6 px-2 text-xs rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
        >
          <ClockIcon className="h-3.5 w-3.5" />
          <span>Resume</span>
          {sessions.length > 0 && (
            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] tabular-nums">
              {sessions.length}
            </span>
          )}
          <span
            className={cn(
              "inline-block transition-transform duration-200",
              open && "rotate-180",
            )}
          >
            ⌄
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-80 p-1">
        <div className="px-2.5 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Agent history
        </div>
        {sessions.length === 0 ? (
          <div className="px-2.5 py-6 text-center text-xs text-muted-foreground">
            {agentId ? "No saved sessions" : "No agent selected"}
          </div>
        ) : (
          <div className="max-h-72 overflow-y-auto">
            {sessions
              .slice()
              .sort((a, b) => {
                const aT = new Date(a.updated_at || a.created_at || "0").getTime()
                const bT = new Date(b.updated_at || b.created_at || "0").getTime()
                return bT - aT
              })
              .map((session) => {
                const isActive = activeSessionId === session.session_id
                return (
                  <button
                    key={session.session_id}
                    type="button"
                    onClick={() => handleSelect(session.session_id)}
                    className={cn(
                      "w-full flex items-center gap-2.5 px-2.5 py-2 text-left rounded-lg transition-colors",
                      isActive
                        ? "bg-accent text-accent-foreground"
                        : "hover:bg-muted/60",
                    )}
                  >
                    <span
                      className={cn(
                        "h-2 w-2 shrink-0 rounded-full",
                        isActive ? "bg-primary" : "bg-muted-foreground/40",
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">
                        {session.title || session.session_id.slice(0, 12)}
                      </div>
                      <div className="truncate text-[11px] text-muted-foreground">
                        {formatTimeAgo(session.updated_at || session.created_at)}
                      </div>
                    </div>
                  </button>
                )
              })}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}