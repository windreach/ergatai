import { useState } from "react"
import { Clock, FolderOpen, Play, Trash2 } from "lucide-react"

import { trpc } from "../../../lib/trpc"
import { Badge } from "../../../components/ui/badge"
import { Button } from "../../../components/ui/button"
import { Skeleton } from "../../../components/ui/skeleton"
import { cn } from "../../../lib/utils"

interface AgentSession {
  session_id: string
  title: string | null
  created_at: string
}

export function AgentSessionsPanel({
  agentId,
  className,
}: {
  agentId: string
  className?: string
}) {
  const utils = trpc.useUtils()
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)

  const sessionsQuery = trpc.ergatai.listAgentSessions.useQuery(
    { agentId },
    { enabled: !!agentId },
  )

  const createSession = trpc.ergatai.createAgentSession.useMutation({
    onSuccess: () => utils.ergatai.listAgentSessions.invalidate({ agentId }),
  })
  const loadSession = trpc.ergatai.loadAgentSession.useMutation({
    onSuccess: (_data, variables) => setActiveSessionId(variables.sessionId),
  })
  const deleteSession = trpc.ergatai.deleteAgentSession.useMutation({
    onSuccess: () => utils.ergatai.listAgentSessions.invalidate({ agentId }),
  })

  const sessions: AgentSession[] = Array.isArray(sessionsQuery.data)
    ? (sessionsQuery.data as AgentSession[])
    : []

  if (!agentId) return null

  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex items-center gap-1.5 px-1 text-xs font-medium text-muted-foreground">
        <Clock className="size-3.5" />
        Sessions
        <Badge variant="secondary" className="ml-auto text-[10px]">
          {sessions.length}
        </Badge>
        <Button
          variant="ghost"
          size="icon"
          className="size-5 p-0"
          disabled={createSession.isPending}
          onClick={() => createSession.mutate({ agentId })}
          aria-label="Create session"
        >
          +
        </Button>
      </div>
      {sessionsQuery.isLoading ? (
        <Skeleton className="h-16 w-full" />
      ) : sessions.length === 0 ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">No saved sessions</p>
      ) : (
        <div className="rounded-md border">
          {sessions.map((session) => (
            <div
              key={session.session_id}
              className={cn(
                "group flex items-center gap-2 px-3 py-1.5 text-xs",
                activeSessionId === session.session_id && "bg-muted",
              )}
            >
              <span className="truncate font-mono">{session.session_id.slice(0, 12)}</span>
              {session.title && (
                <span className="truncate text-muted-foreground">{session.title}</span>
              )}
              <div className="ml-auto flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100">
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-5 p-0"
                  disabled={loadSession.isPending}
                  onClick={() =>
                    loadSession.mutate({ agentId, sessionId: session.session_id })
                  }
                  aria-label="Load session"
                >
                  <Play className="size-3" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-5 p-0 text-destructive"
                  disabled={deleteSession.isPending}
                  onClick={() =>
                    deleteSession.mutate({ agentId, sessionId: session.session_id })
                  }
                  aria-label="Delete session"
                >
                  <Trash2 className="size-3" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
