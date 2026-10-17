"use client"

import { useEffect, useRef, useState } from "react"
import {
  Bird,
  Braces,
  ChevronDown,
  Gem,
  Plus,
  Rocket,
  Sparkles,
  TerminalSquare,
  Zap,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  CheckIcon,
  ClaudeCodeIcon,
  CodexIcon,
  CursorIcon,
} from "@/components/ui/icons"
import { cn } from "@/lib/utils"
import {
  agentContractApi,
  type CoreAgentId,
  type CoreAgentOption,
} from "../lib/agent-contract-api"

interface CoreAgentSelectorProps {
  value?: CoreAgentId
  onChange?: (agent: CoreAgentOption) => void
  className?: string
  compact?: boolean
  groupAgentIds?: CoreAgentId[]
  onChangeGroupAgents?: (agentIds: CoreAgentId[]) => void
}

export function getCoreAgentIcon(agentId: CoreAgentId) {
  if (agentId === "codex") return CodexIcon
  if (agentId === "cursor") return CursorIcon
  if (agentId === "opencode") return TerminalSquare
  if (agentId === "gemini") return Gem
  if (agentId === "goose") return Bird
  if (agentId === "cline") return Braces
  if (agentId === "kiro") return Zap
  if (agentId === "auggie") return Sparkles
  if (agentId === "hermes") return Rocket
  if (agentId === "openclaw") return TerminalSquare
  return ClaudeCodeIcon
}

export function CoreAgentSelector({
  value = "claude-code",
  onChange,
  className,
  compact = false,
  groupAgentIds,
  onChangeGroupAgents,
}: CoreAgentSelectorProps) {
  const [agents, setAgents] = useState<CoreAgentOption[]>([])
  const [selectedAgent, setSelectedAgent] = useState<CoreAgentOption>({
    id: value,
    name: value === "codex" ? "Codex" : "Claude Code",
  })

  useEffect(() => {
    let cancelled = false

    void agentContractApi.listCoreAgents().then((options) => {
      if (cancelled) return
      setAgents(options)
      setSelectedAgent((current) =>
        options.find((agent) => agent.id === current.id) ?? options[0] ?? current,
      )
    })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    setSelectedAgent((current) =>
      current.id === value
        ? current
        : { id: value, name: value === "codex" ? "Codex" : "Claude Code" },
    )
  }, [value])

  if (compact) {
    const selectedAgentIds = groupAgentIds ?? [selectedAgent.id]
    const visibleAgents = selectedAgentIds
      .slice(0, 3)
      .map((agentId) => agents.find((agent) => agent.id === agentId))
      .filter((agent): agent is CoreAgentOption => Boolean(agent))
    const overflowCount = Math.max(0, selectedAgentIds.length - 3)

    return (
      <GroupAgentSelector
        className={className}
        agents={agents}
        selectedAgentIds={selectedAgentIds}
        visibleAgents={visibleAgents}
        overflowCount={overflowCount}
        onChange={(agentIds) => {
          onChangeGroupAgents?.(agentIds)

          const primaryAgent = agents.find((agent) => agent.id === agentIds[0])

          if (primaryAgent) {
            setSelectedAgent(primaryAgent)
            onChange?.(primaryAgent)
          }
        }}
      />
    )
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-sm text-muted-foreground transition-[background-color,color] duration-150 ease-out hover:bg-muted/50 hover:text-foreground",
            className,
          )}
        >
          {(() => {
            const SelectedIcon = getCoreAgentIcon(selectedAgent.id)

            return <SelectedIcon className="h-3.5 w-3.5 shrink-0" />
          })()}
          <span className="truncate">{selectedAgent.name}</span>
          <ChevronDown className="h-3 w-3 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-44 p-1">
        {agents.map((agent) => {
          const Icon = getCoreAgentIcon(agent.id)

          return (
            <button
              key={agent.id}
              type="button"
              onClick={() => {
                setSelectedAgent(agent)
                onChange?.(agent)
              }}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent/50",
                agent.id === selectedAgent.id && "bg-accent/30",
              )}
            >
              <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate">{agent.name}</span>
            </button>
          )
        })}
      </PopoverContent>
    </Popover>
  )
}

function GroupAgentSelector({
  className,
  agents,
  selectedAgentIds,
  visibleAgents,
  overflowCount,
  onChange,
}: {
  className?: string
  agents: CoreAgentOption[]
  selectedAgentIds: CoreAgentId[]
  visibleAgents: CoreAgentOption[]
  overflowCount: number
  onChange: (agentIds: CoreAgentId[]) => void
}) {
  const [open, setOpen] = useState(false)
  const [draftAgentIds, setDraftAgentIds] =
    useState<CoreAgentId[]>(selectedAgentIds)
  const panelRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (open) {
      setDraftAgentIds(selectedAgentIds)
    }
  }, [open, selectedAgentIds])

  useEffect(() => {
    if (!open) return

    const handlePointerDown = (event: PointerEvent) => {
      if (!panelRef.current?.contains(event.target as Node)) {
        setOpen(false)
      }
    }

    document.addEventListener("pointerdown", handlePointerDown)
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown)
    }
  }, [open])

  const toggleDraftAgent = (agentId: CoreAgentId) => {
    setDraftAgentIds((current) => {
      if (current.includes(agentId)) {
        return current.length <= 1
          ? current
          : current.filter((id) => id !== agentId)
      }

      return [...current, agentId]
    })
  }

  return (
    <div className={cn("flex items-center gap-0.5", className)}>
      {visibleAgents.map((agent) => {
        const Icon = getCoreAgentIcon(agent.id)

        return (
          <span
            key={agent.id}
            title={agent.name}
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground"
          >
            <Icon className="h-4 w-4 shrink-0" />
          </span>
        )
      })}

      {overflowCount > 0 && (
        <button
          type="button"
          aria-label="More agents"
          onClick={() => setOpen(true)}
          className="flex h-7 items-center rounded-md px-1 text-sm text-muted-foreground transition-[background-color,color] duration-150 ease-out hover:bg-muted/50 hover:text-foreground"
        >
          ...
        </button>
      )}

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label="Add agent"
            className="flex h-6 w-6 items-center justify-center rounded-full border border-dashed text-muted-foreground transition-[background-color,border-color,color] duration-150 ease-out hover:bg-muted/50 hover:text-foreground"
          >
            <Plus className="h-3 w-3" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          ref={panelRef}
          align="start"
          className="w-64 p-3"
          onEscapeKeyDown={(event) => event.preventDefault()}
          onPointerDownOutside={(event) => event.preventDefault()}
          onFocusOutside={(event) => event.preventDefault()}
        >
          <div className="mb-1 flex items-center justify-between">
            <span className="text-sm font-medium">Add agent</span>
          </div>
          <div className="space-y-0.5">
            {agents.map((agent) => {
              const Icon = getCoreAgentIcon(agent.id)
              const isSelected = draftAgentIds.includes(agent.id)

              return (
                <button
                  key={agent.id}
                  type="button"
                  onClick={() => toggleDraftAgent(agent.id)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent/50",
                    isSelected && "bg-accent/30",
                  )}
                >
                  <Checkbox
                    checked={isSelected}
                    className="pointer-events-none"
                    tabIndex={-1}
                  />
                  <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{agent.name}</span>
                  {isSelected && <CheckIcon className="h-3.5 w-3.5" />}
                </button>
              )
            })}
          </div>

          <div className="mt-3 flex justify-end">
            <Button
              size="sm"
              onClick={() => {
                onChange(draftAgentIds)
                setOpen(false)
              }}
            >
              Save
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}
