import { useMemo, useState } from "react"
import { AlertTriangle, Check, ChevronDown, Copy } from "lucide-react"

import { cn } from "@/lib/utils"
import {
  getChatErrorDisplay,
  type ChatErrorInfo,
} from "../../../../shared/chat-error"

export interface ChatErrorCardProps {
  error: ChatErrorInfo
  className?: string
  /** Optional retry action. Hidden when undefined or while streaming. */
  onRetry?: () => void
  retryDisabled?: boolean
  /** Optional model-switch action for model_not_found. */
  onSwitchModel?: () => void
}

function buildDetails(error: ChatErrorInfo): string {
  const details: Record<string, unknown> = {
    message: error.message,
    errorName: error.errorName,
    errorType: error.errorType,
    service: error.service,
    code: error.code,
    data: error.data,
  }
  if (error.rawText) details.rawText = error.rawText
  return JSON.stringify(details, null, 2)
}

export function ChatErrorCard({
  error,
  className,
  onRetry,
  retryDisabled = false,
  onSwitchModel,
}: ChatErrorCardProps) {
  const [copied, setCopied] = useState(false)
  const display = useMemo(() => getChatErrorDisplay(error), [error])
  const details = useMemo(() => buildDetails(error), [error])

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(details)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard access can fail in constrained environments; the details
      // panel is still selectable.
    }
  }

  return (
    <div
      className={cn(
        "my-2 w-full min-w-0 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-xs",
        className,
      )}
      data-testid="chat-error-card"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-destructive" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-medium text-destructive">{display.title}</span>
            {error.errorName && (
              <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-[10px] font-mono text-destructive/80">
                {error.errorName}
              </span>
            )}
            {error.repeatCount && error.repeatCount > 1 && (
              <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-[10px] text-destructive/80">
                重复 {error.repeatCount} 次
              </span>
            )}
          </div>
          <p className="mt-1 text-muted-foreground">{display.description}</p>

          {(onRetry || onSwitchModel) && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {onRetry && (
                <button
                  type="button"
                  onClick={onRetry}
                  disabled={retryDisabled}
                  className="rounded border border-destructive/30 bg-background/60 px-2 py-1 font-medium text-foreground transition-colors hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  重试
                </button>
              )}
              {onSwitchModel && (
                <button
                  type="button"
                  onClick={onSwitchModel}
                  className="rounded border border-border bg-background/60 px-2 py-1 font-medium text-foreground transition-colors hover:bg-accent"
                >
                  切换模型
                </button>
              )}
            </div>
          )}

          <details className="group mt-2">
            <summary className="flex cursor-pointer list-none items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground">
              <ChevronDown className="h-3 w-3 transition-transform group-open:rotate-180" />
              技术详情
            </summary>
            <div className="relative mt-1.5">
              <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded border border-border/60 bg-background/70 p-2 font-mono text-[10px] leading-relaxed text-muted-foreground">
                {details}
              </pre>
              <button
                type="button"
                onClick={handleCopy}
                aria-label="复制错误详情"
                className="absolute right-1.5 top-1.5 rounded border border-border/60 bg-background/90 p-1 text-muted-foreground transition-colors hover:text-foreground"
              >
                {copied ? (
                  <Check className="h-3 w-3 text-emerald-500" />
                ) : (
                  <Copy className="h-3 w-3" />
                )}
              </button>
            </div>
          </details>
        </div>
      </div>
    </div>
  )
}
