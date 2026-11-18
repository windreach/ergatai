import i18n from "@/lib/i18n"
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
  errorText?: string
  /**
   * Render the failure reason inline next to the title instead of as a red
   * row below. The title also keeps its normal color.
   */
  inlineError?: boolean
  isNested?: boolean
  onClick?: () => void
}

export const AgentToolCall = memo(
  function AgentToolCall({
    title,
    subtitle,
    tooltipContent,
    isPending,
    isError,
    errorText,
    inlineError,
    isNested,
    onClick,
  }: AgentToolCallProps) {
    // Ensure title and subtitle are strings (copied from canvas)
    const titleStr = String(title)
    const subtitleStr = subtitle ? String(subtitle) : undefined
    const showError = Boolean(isError) && !isPending
    const rawErrorText = errorText?.trim() ?? ""
    // Older persisted parts stored the tool title as the error message; don't
    // echo it under the row as if it were a failure reason. Compare
    // case-insensitively because ACP tool names arrive lowercase (e.g. the
    // Read tool reports its title as "read").
    const normalizeEcho = (value: string) => value.trim().toLowerCase()
    const isTitleEcho =
      normalizeEcho(rawErrorText) === normalizeEcho(titleStr) ||
      (Boolean(subtitleStr) &&
        normalizeEcho(rawErrorText) ===
          normalizeEcho(`${titleStr} ${subtitleStr}`))
    const errorDetail =
      rawErrorText && !isTitleEcho ? rawErrorText : i18n.t("Failed")

    // Inline errors replace the subtitle (usually the file name) with the
    // failure reason, keeping the row neutral instead of red.
    const showInlineError = showError && Boolean(inlineError)
    const showStackedError = showError && !showInlineError
    const subtitleText = showInlineError ? errorDetail : subtitleStr
    const subtitleTooltip = showInlineError ? errorDetail : tooltipContent

    // Render subtitle with optional tooltip
    const clickableClass = onClick
      ? " cursor-pointer hover:text-muted-foreground transition-colors"
      : ""

    const subtitleElement = (() => {
      if (!subtitleText) return null
      if (subtitleTooltip) {
        return (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                // react-doctor-disable-next-line prefer-tag-over-role
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault()
                    ;(e.currentTarget as HTMLElement).click()
                  }
                }}
                className={`text-muted-foreground/60 font-normal truncate min-w-0${clickableClass}`}
                onClick={onClick}
              >
                {subtitleText}
              </span>
            </TooltipTrigger>
            <TooltipContent
              side="top"
              className="px-2 py-1.5 max-w-none flex items-center justify-center"
            >
              <span className="font-mono text-[10px] text-muted-foreground whitespace-nowrap leading-none">
                {subtitleTooltip}
              </span>
            </TooltipContent>
          </Tooltip>
        )
      }
      return (
        <span
          // react-doctor-disable-next-line prefer-tag-over-role
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault()
              ;(e.currentTarget as HTMLElement).click()
            }
          }}
          className={`text-muted-foreground/60 font-normal truncate min-w-0${clickableClass}`}
          onClick={onClick}
        >
          {subtitleText}
        </span>
      )
    })()

    return (
      <div
        className={`flex flex-col py-0.5 ${
          isNested ? "px-2.5" : "rounded-md px-2"
        }`}
      >
        {/* Content container - matches canvas exactly */}
        <div className="flex-1 min-w-0 flex items-center gap-1.5">
          <div className="text-xs text-muted-foreground flex items-center gap-1.5 min-w-0">
            <span
              className={`font-medium whitespace-nowrap flex-shrink-0${
                showStackedError ? " text-red-500" : ""
              }`}
            >
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
        {showStackedError && (
          <div className="mt-0.5 pl-2 text-xs text-red-500/90 whitespace-pre-wrap break-words">
            {errorDetail}
          </div>
        )}
      </div>
    )
  }
)
