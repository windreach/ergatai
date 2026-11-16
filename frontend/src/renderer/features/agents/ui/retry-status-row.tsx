import { useEffect, useState } from "react"
import { Loader2, Square } from "lucide-react"

import { cn } from "@/lib/utils"

export type RetryStatus = {
  attempt: number
  maxAttempts: number
  delayMs: number
  nextRetryAtMs: number
  errorName?: string | null
  message?: string
  messageId?: string | null
}

export interface RetryStatusRowProps {
  retry: RetryStatus
  className?: string
  onStop?: () => void
  stopDisabled?: boolean
}

function useRetryCountdown(nextRetryAtMs: number): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    setNow(Date.now())
    if (!nextRetryAtMs) return
    const timer = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(timer)
  }, [nextRetryAtMs])

  if (!nextRetryAtMs) return 0
  return Math.max(0, Math.ceil((nextRetryAtMs - now) / 1000))
}

export function RetryStatusRow({
  retry,
  className,
  onStop,
  stopDisabled = false,
}: RetryStatusRowProps) {
  const secondsLeft = useRetryCountdown(retry.nextRetryAtMs)
  const attempt = Math.max(1, retry.attempt)
  const maxAttempts = Math.max(attempt, retry.maxAttempts)

  return (
    <div
      className={cn(
        "mx-2 mb-2 flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400",
        className,
      )}
      role="status"
      aria-live="polite"
      data-testid="retry-status-row"
    >
      <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin" />
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-0.5">
        <span className="font-medium">
          正在自动重试 {attempt}/{maxAttempts}
        </span>
        <span className="text-amber-600/80 dark:text-amber-400/70">
          {secondsLeft > 0 ? `· ${secondsLeft} 秒后重试` : "· 正在重试…"}
        </span>
        {retry.errorName && (
          <span className="rounded bg-amber-500/10 px-1.5 py-0.5 font-mono text-[10px] text-amber-700/80 dark:text-amber-400/80">
            {retry.errorName}
          </span>
        )}
      </div>
      {onStop && (
        <button
          type="button"
          onClick={onStop}
          disabled={stopDisabled}
          className="flex flex-shrink-0 items-center gap-1 rounded border border-amber-500/30 bg-background/50 px-1.5 py-0.5 font-medium text-foreground transition-colors hover:bg-amber-500/10 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Square className="h-2.5 w-2.5 fill-current" />
          停止
        </button>
      )}
    </div>
  )
}
