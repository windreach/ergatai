"use client"

import { memo, useMemo, useState } from "react"
import { ChevronRight } from "lucide-react"
import { IconSpinner } from "../../../components/ui/icons"
import { TextShimmer } from "../../../components/ui/text-shimmer"
import { getToolStatus } from "./agent-tool-registry"
import { areToolPropsEqual } from "./agent-tool-utils"
import type { MessagePart } from "../stores/message-store"
import { cn } from "../../../lib/utils"

interface AgentGrepToolProps {
  // `any` is used because the part shape varies across tool call stages
  // (pending vs. completed) and output formats (string, object, array).
  // A strict interface would require discriminated unions across multiple
  // call sites; `any` keeps this component permissive to agent output shapes.
  part: MessagePart
  messageId?: string
  partIndex?: number
  chatStatus?: string
}

const MAX_DETAIL_CHARS = 4_000

// Extract human-readable match details from whatever output shape the agent produced
function extractMatchDetails(output: any): string {
  if (!output) return ""
  if (typeof output === "string") return output.slice(0, MAX_DETAIL_CHARS)
  if (typeof output !== "object") return String(output).slice(0, MAX_DETAIL_CHARS)
  if (typeof output.content === "string" && output.content) {
    return output.content.slice(0, MAX_DETAIL_CHARS)
  }
  if (Array.isArray(output.filenames) && output.filenames.length > 0) {
    return output.filenames.slice(0, 50).join("\n")
  }
  try {
    return JSON.stringify(output, null, 2).slice(0, MAX_DETAIL_CHARS)
  } catch {
    return ""
  }
}

export const AgentGrepTool = memo(function AgentGrepTool({
  part,
  messageId,
  partIndex,
  chatStatus,
}: AgentGrepToolProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  const { isPending } = getToolStatus(part, chatStatus)

  const pattern = part.input?.pattern || ""
  const path = part.input?.path || ""
  const output = part.output

  // Only trust match counts when the output actually carries stats,
  // otherwise the result shape is unknown and "No matches" would be a lie.
  const hasStats =
    output != null &&
    typeof output === "object" &&
    (output.mode !== undefined ||
      output.numFiles !== undefined ||
      output.numLines !== undefined ||
      Array.isArray(output.filenames))
  const numFiles = output?.numFiles ?? 0
  const mode = output?.mode
  const numLines = output?.numLines ?? 0

  // Collapsed row shows the result: "grep: <result>"
  let result: string
  if (isPending) {
    result = "searching"
  } else if (hasStats) {
    if (mode === "content") {
      result = numLines > 0 ? `${numLines} matches` : "no matches"
    } else {
      result = numFiles > 0 ? `${numFiles} files` : "no matches"
    }
  } else {
    result = "done"
  }

  const detailText = useMemo(
    () => (isExpanded ? extractMatchDetails(output) : ""),
    [output, isExpanded],
  )

  return (
    <div
      data-message-id={messageId}
      data-part-index={partIndex}
      data-part-type="tool-Grep"
    >
      {/* Header - flat muted row: "grep: <result>", click to expand */}
      <div
        onClick={() => setIsExpanded(!isExpanded)}
        className="group flex items-start gap-1.5 py-0.5 px-2 cursor-pointer"
      >
        <div className="flex-1 min-w-0 flex items-center gap-1">
          <div className="text-xs flex items-center gap-1.5 min-w-0">
            <span className="text-muted-foreground whitespace-nowrap flex-shrink-0">
              grep:
            </span>
            {isPending ? (
              <TextShimmer
                as="span"
                duration={1.2}
                className="inline-flex items-center text-xs leading-none h-4 m-0"
              >
                {result}
              </TextShimmer>
            ) : (
              <span className="text-muted-foreground truncate">{result}</span>
            )}
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

      {/* Detail - the full search instruction and matches */}
      {isExpanded && (
        <div className="px-2 pb-1.5 pl-7 space-y-1">
          {pattern && (
            <div className="font-mono text-xs text-foreground whitespace-pre-wrap break-all">
              <span className="text-amber-600 dark:text-amber-400">? </span>
              {pattern}
            </div>
          )}
          {path && (
            <div className="font-mono text-xs text-muted-foreground whitespace-pre-wrap break-all">
              in {path}
            </div>
          )}
          {detailText && (
            <div className="font-mono text-xs text-muted-foreground whitespace-pre-wrap break-all">
              {detailText}
            </div>
          )}
        </div>
      )}
    </div>
  )
}, areToolPropsEqual)
