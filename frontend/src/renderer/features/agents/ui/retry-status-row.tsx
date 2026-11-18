import i18n from "@/lib/i18n"
import { useEffect, useState } from "react"
import { Loader2 } from "lucide-react"

import { cn } from "@/lib/utils"
import { useTranslation } from "react-i18next"

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
}: RetryStatusRowProps) {
  const { t } = useTranslation()
  const secondsLeft = useRetryCountdown(retry.nextRetryAtMs)
  const attempt = Math.max(1, retry.attempt)
  const maxAttempts = Math.max(attempt, retry.maxAttempts)

  return (
    <div
      className={cn(
        "my-2 flex w-full min-w-0 items-center gap-2 text-xs text-amber-600 dark:text-amber-400",
        className,
      )}
      role="status"
      aria-live="polite"
      data-testid="retry-status-row"
    >
      <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin" />
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-0.5">
        <span className="font-medium">
          {t("retry.autoRetrying", { attempt, max: maxAttempts })}
        </span>
        <span className="text-amber-600/80 dark:text-amber-400/70">
          {secondsLeft > 0 ? t("retry.retryIn", { seconds: secondsLeft }) : t("retry.retrying")}
        </span>
        {retry.errorName && (
          <span className="font-mono text-[10px] text-amber-600/70 dark:text-amber-400/70">
            {retry.errorName}
          </span>
        )}
      </div>
    </div>
  )
}