"use client"

import { memo, useState, useMemo } from "react"
import { Check, ChevronRight, X } from "lucide-react"
import { useAtomValue } from "jotai"
import { IconSpinner } from "../../../components/ui/icons"
import { TextShimmer } from "../../../components/ui/text-shimmer"
import { getToolStatus } from "./agent-tool-registry"
import { AgentToolInterrupted } from "./agent-tool-interrupted"
import { areToolPropsEqual } from "./agent-tool-utils"
import type { MessagePart } from "../stores/message-store"
import { cn } from "../../../lib/utils"
import { selectedWorkspaceAtom } from "../atoms"

interface AgentBashToolProps {
  // AI SDK tool part shape is dynamic/loosely typed
  part: MessagePart
  messageId?: string
  partIndex?: number
  chatStatus?: string
}

// Extract command summary - first word of each command in a pipeline
function extractCommandSummary(command: string): string {
  if (!command || typeof command !== "string") return ""
  // First, normalize line continuations (backslash + newline) into single line
  const normalizedCommand = command.replace(/\\\s*\n\s*/g, " ")
  // Known limitation: This simple split on &&, ||, ;, | doesn't handle quoted strings
  // correctly (e.g., "echo 'foo && bar'" would be split incorrectly). For display purposes
  // this is acceptable since we only show the first 4 command names as a summary.
  const parts = normalizedCommand.split(/\s*(?:&&|\|\||;|\|)\s*/)
  const firstWords = parts.map((p) => p.trim().split(/\s+/)[0]).filter(Boolean)
  // Limit to first 4 commands to keep it concise
  const limited = firstWords.slice(0, 4)
  if (firstWords.length > 4) {
    return limited.join(", ") + "..."
  }
  return limited.join(", ")
}

// Replace absolute project paths with relative paths in a string
function shortenPaths(text: string, projectPath: string | undefined): string {
  if (!text || !projectPath || typeof text !== "string") return text || ""
  // Use regex to ensure path is followed by non-alphanumeric char or end of string
  // This prevents substring matches (e.g., /home/user/foo matching /home/user/foobar)
  const escaped = projectPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return text
    .replace(new RegExp(escaped + '/', 'g'), '')
    .replace(new RegExp(escaped + '(?=[^\\w]|$)', 'g'), '.')
}

export const AgentBashTool = memo(function AgentBashTool({
  part,
  messageId,
  partIndex,
  chatStatus,
}: AgentBashToolProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  const { isPending } = getToolStatus(part, chatStatus)
  const selectedWorkspace = useAtomValue(selectedWorkspaceAtom)
  const projectPath = selectedWorkspace?.path

  const rawCommand = part.input?.command
  const command = typeof rawCommand === "string" ? rawCommand : rawCommand ? String(rawCommand) : ""
  const stdout = part.output?.stdout || part.output?.output || ""
  const stderr = part.output?.stderr || ""
  const rawExitCode = part.output?.exitCode ?? part.output?.exit_code
  const exitCode = rawExitCode !== undefined ? Number(rawExitCode) : undefined

  // For bash tools, success/error is determined by exitCode, not by state
  // exitCode 0 = success, anything else (or undefined if no output yet) = error
  const isSuccess = exitCode === 0
  const isError = exitCode !== undefined && exitCode !== 0

  // Shorten paths in the displayed command
  const displayCommand = useMemo(
    () => shortenPaths(command, projectPath),
    [command, projectPath],
  )

  // Memoize command summary to avoid recalculation on every render
  const commandSummary = useMemo(
    () => extractCommandSummary(displayCommand),
    [displayCommand],
  )

  // Check if command input is still being streamed
  // Only consider streaming if chat is actively streaming (prevents hang on stop)
  // Include "submitted" status - this is when request was sent but streaming hasn't started yet
  const isActivelyStreaming = chatStatus === "streaming" || chatStatus === "submitted"
  const isInputStreaming = part.state === "input-streaming" && isActivelyStreaming

  // If command is still being generated (input-streaming state), show loading state
  if (isInputStreaming) {
    return (
      <div className="flex items-start gap-1.5 rounded-md py-0.5 px-2">
        <div className="flex-1 min-w-0 flex items-center gap-1.5">
          <div className="text-xs text-muted-foreground flex items-center gap-1.5 min-w-0">
            <span className="font-medium whitespace-nowrap flex-shrink-0">
              <TextShimmer
                as="span"
                duration={1.2}
                className="inline-flex items-center text-xs leading-none h-4 m-0"
              >
                Generating command
              </TextShimmer>
            </span>
          </div>
        </div>
      </div>
    )
  }

  // If no command and not streaming, tool was interrupted
  if (!command) {
    return <AgentToolInterrupted toolName="Command" />
  }

  return (
    <div
      data-message-id={messageId}
      data-part-index={partIndex}
      data-part-type="tool-Bash"
    >
      {/* Header - flat muted row (same style as Thinking), click to toggle */}
      <div
        onClick={() => setIsExpanded(!isExpanded)}
        className="group flex items-start gap-1.5 py-0.5 px-2 cursor-pointer"
      >
        <div className="flex-1 min-w-0 flex items-center gap-1">
          <div className="text-xs flex items-center gap-1.5 min-w-0">
            <span className="text-muted-foreground truncate">
              {isPending ? "Running command: " : "Ran command: "}
              {commandSummary}
            </span>
            {/* Status */}
            {!isPending &&
              (isSuccess ? (
                <Check className="w-3 h-3 flex-shrink-0 text-muted-foreground/60" />
              ) : isError ? (
                <X className="w-3 h-3 flex-shrink-0 text-rose-500" />
              ) : null)}
            {isPending && <IconSpinner className="w-3 h-3 flex-shrink-0" />}
          </div>
        </div>
        {/* Chevron */}
        <ChevronRight
          className={cn(
            "w-3.5 h-3.5 text-muted-foreground/60 transition-transform duration-200 ease-out flex-shrink-0",
            isExpanded && "rotate-90",
            !isExpanded && "opacity-0 group-hover:opacity-100",
          )}
        />
      </div>

      {/* Content - hidden by default, shown when expanded */}
      {isExpanded && (
        <div className="px-2 pb-1.5 pl-7">
          {/* Command - always show full command */}
          <div className="font-mono text-xs">
            <span className="text-amber-600 dark:text-amber-400">$ </span>
            <span className="text-foreground whitespace-pre-wrap break-all">
              {displayCommand}
            </span>
          </div>

          {/* Stdout */}
          {stdout && (
            <div className="mt-1.5 font-mono text-xs text-muted-foreground whitespace-pre-wrap break-all">
              {stdout}
            </div>
          )}

          {/* Stderr - warning/error color based on exit code */}
          {stderr && (
            <div
              className={cn(
                "mt-1.5 font-mono text-xs whitespace-pre-wrap break-all",
                // If exitCode is 0, it's a warning (e.g. npm warnings)
                // If exitCode is non-zero, it's an error
                exitCode === 0 || exitCode === undefined
                  ? "text-amber-600 dark:text-amber-400"
                  : "text-rose-500 dark:text-rose-400",
              )}
            >
              {stderr}
            </div>
          )}
        </div>
      )}
    </div>
  )
}, areToolPropsEqual)
