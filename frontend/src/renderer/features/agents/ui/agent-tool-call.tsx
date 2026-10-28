"use client"

import { memo } from "react"
import { TextShimmer } from "../../../components/ui/text-shimmer"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../../../components/ui/tooltip"

interface AgentToolCallProps {
  icon?: React.ComponentType<{ className?: string }>
  title: string
  subtitle?: string
  tooltipContent?: string
  isPending: boolean
  isError?: boolean
  isNested?: boolean
  onClick?: () => void
}

export const AgentToolCall = memo(
  function AgentToolCall({
    title,
    subtitle,
    tooltipContent,
    isPending,
    isNested,
    onClick,
  }: AgentToolCallProps) {
    // Ensure title and subtitle are strings (copied from canvas)
    const titleStr = String(title)
    const subtitleStr = subtitle ? String(subtitle) : undefined

    // Render subtitle with optional tooltip
    const clickableClass = onClick
      ? " cursor-pointer hover:text-muted-foreground transition-colors"
      : ""

    const subtitleElement = (() => {
      if (!subtitleStr) return null
      if (tooltipContent) {
        return (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className={`text-muted-foreground/60 font-normal truncate min-w-0${clickableClass}`}
                onClick={onClick}
              >
                {subtitleStr}
              </span>
            </TooltipTrigger>
            <TooltipContent
              side="top"
              className="px-2 py-1.5 max-w-none flex items-center justify-center"
            >
              <span className="font-mono text-[10px] text-muted-foreground whitespace-nowrap leading-none">
                {tooltipContent}
              </span>
            </TooltipContent>
          </Tooltip>
        )
      }
      return (
        <span
          className={`text-muted-foreground/60 font-normal truncate min-w-0${clickableClass}`}
          onClick={onClick}
        >
          {subtitleStr}
        </span>
      )
    })()

    return (
      <div
        className={`flex items-start gap-1.5 py-0.5 ${
          isNested ? "px-2.5" : "rounded-md px-2"
        }`}
      >
        {/* Content container - matches canvas exactly */}
        <div className="flex-1 min-w-0 flex items-center gap-1.5">
          <div className="text-xs text-muted-foreground flex items-center gap-1.5 min-w-0">
            <span className="font-medium whitespace-nowrap flex-shrink-0">
              {isPending ? (
                <TextShimmer
                  as="span"
                  duration={1.2}
                  className="inline-flex items-center text-xs leading-none h-4 m-0"
                >
                  {titleStr}
                </TextShimmer>
              ) : (
                titleStr
              )}
            </span>
            {subtitleElement}
          </div>
        </div>
      </div>
    )
  }
)
