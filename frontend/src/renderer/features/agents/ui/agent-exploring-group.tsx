"use client"

import { memo, useState, useEffect, useRef } from "react"
import { useAtomValue } from "jotai"
import { ChevronRight } from "lucide-react"
import { useFileOpen } from "../mentions"
import { selectedWorkspaceAtom } from "../atoms"
import { AgentToolRegistry, getToolStatus } from "./agent-tool-registry"
import { AgentToolCall } from "./agent-tool-call"
import { areExploringGroupPropsEqual } from "./agent-tool-utils"
import { cn } from "../../../lib/utils"
import type { MessagePart } from "../stores/message-store"

interface AgentExploringGroupProps {
  parts: MessagePart[]
  chatStatus?: string
  isStreaming: boolean
}

// Constants for rendering
const MAX_VISIBLE_TOOLS = 5
const TOOL_HEIGHT_PX = 24

// Tool type constants for file operations
const FILE_TOOL_TYPES = ["tool-Read", "tool-Grep", "tool-Glob"] as const
// Tool type constants for search operations
const SEARCH_TOOL_TYPES = ["tool-WebSearch", "tool-WebFetch"] as const

export const AgentExploringGroup = memo(function AgentExploringGroup({
  parts,
  chatStatus,
  isStreaming,
}: AgentExploringGroupProps) {
  const onOpenFile = useFileOpen()
  const selectedWorkspace = useAtomValue(selectedWorkspaceAtom)
  const projectPath = selectedWorkspace?.path
  // Default: expanded while streaming, collapsed when done
  const [isExpanded, setIsExpanded] = useState(isStreaming)
  const scrollRef = useRef<HTMLDivElement>(null)
  const wasStreamingRef = useRef(isStreaming)

  // Auto-collapse when streaming ends (transition from true -> false)
  useEffect(() => {
    if (wasStreamingRef.current && !isStreaming) {
      setIsExpanded(false)
    }
    wasStreamingRef.current = isStreaming
  }, [isStreaming])

  // Auto-scroll to bottom when streaming and new parts added
  // Depend on parts directly instead of parts.length for more reliable updates
  useEffect(() => {
    if (isStreaming && isExpanded && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [parts, isStreaming, isExpanded])

  // Count files (Read, Grep, Glob) and searches (WebSearch, WebFetch)
  const fileCount = parts.filter((p) =>
    FILE_TOOL_TYPES.includes(p.type as typeof FILE_TOOL_TYPES[number]),
  ).length
  const searchCount = parts.filter((p) =>
    SEARCH_TOOL_TYPES.includes(p.type as typeof SEARCH_TOOL_TYPES[number]),
  ).length

  // Build subtitle parts
  const subtitleParts: string[] = []
  if (fileCount > 0) {
    subtitleParts.push(`${fileCount} ${fileCount === 1 ? "file" : "files"}`)
  }
  if (searchCount > 0) {
    subtitleParts.push(
      `${searchCount} ${searchCount === 1 ? "search" : "searches"}`,
    )
  }
  const subtitle = subtitleParts.join(" ")

  return (
    <div>
      {/* Header - clickable to toggle */}
      <div
        onClick={() => setIsExpanded(!isExpanded)}
        className="group flex items-start gap-1.5 py-0.5 px-2 cursor-pointer"
      >
        <div className="flex-1 min-w-0 flex items-center gap-1">
          <div className="text-xs flex items-center gap-1.5 min-w-0">
            <span className="font-medium whitespace-nowrap flex-shrink-0 text-muted-foreground">
              {isStreaming ? "Exploring" : "Explored"}
            </span>
            <span className="text-muted-foreground/60 whitespace-nowrap flex-shrink-0">
              {subtitle}
            </span>
            {/* Chevron right after text - rotates when expanded */}
            <ChevronRight
              className={cn(
                "w-3.5 h-3.5 text-muted-foreground/60 transition-transform duration-200 ease-out",
                isExpanded && "rotate-90",
                !isExpanded && "opacity-0 group-hover:opacity-100",
              )}
            />
          </div>
        </div>
      </div>

      {/* Tools list - only show when expanded */}
      {isExpanded && (
        <div className="relative mt-1">
          {/* Top gradient fade when streaming and has many items */}
          <div
            className={cn(
              "absolute inset-x-0 top-0 h-8 bg-gradient-to-b from-background to-transparent z-10 pointer-events-none transition-opacity duration-200",
              isStreaming && parts.length > MAX_VISIBLE_TOOLS
                ? "opacity-100"
                : "opacity-0",
            )}
          />

          {/* Scrollable container - auto-scrolls to bottom when streaming */}
          <div
            ref={scrollRef}
            className={cn(
              "space-y-1.5",
              parts.length > MAX_VISIBLE_TOOLS &&
                "overflow-y-auto scrollbar-hide",
            )}
            style={
              parts.length > MAX_VISIBLE_TOOLS
                ? { maxHeight: `${MAX_VISIBLE_TOOLS * TOOL_HEIGHT_PX}px` }
                : undefined
            }
          >
            {parts.map((part, idx) => {
              const meta = AgentToolRegistry[part.type]
              if (!meta) {
                return (
                  <div
                    key={idx}
                    className="text-xs text-muted-foreground py-0.5 px-2"
                  >
                    {part.type?.replace("tool-", "")}
                  </div>
                )
              }
              const { isPending, isError } = getToolStatus(part, chatStatus)
              const filePath = part.input?._locations?.[0]?.path
              const handleClick =
                part.type === "tool-Read" && onOpenFile && filePath
                  ? () => onOpenFile(filePath)
                  : undefined
              return (
                <AgentToolCall
                  key={idx}
                  icon={meta.icon}
                  title={meta.title(part)}
                  subtitle={meta.subtitle?.(part)}
                  tooltipContent={meta.tooltipContent?.(part, projectPath)}
                  isPending={isPending}
                  isError={isError}
                  onClick={handleClick}
                />
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}, areExploringGroupPropsEqual)
