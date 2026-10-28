"use client"

import { memo, useState, useCallback, useRef, useEffect } from "react"
import { CheckIcon, CopyIcon } from "../../../components/ui/icons"
import { cn } from "../../../lib/utils"
import { useHaptic } from "../hooks/use-haptic"

interface CopyButtonProps {
  text: string
}

export const CopyButton = memo(function CopyButton({
  text,
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false)
  const { trigger: triggerHaptic } = useHaptic()
  const timerRef = useRef<NodeJS.Timeout | null>(null)

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text)
      triggerHaptic("medium")
      setCopied(true)
      // Clear any existing timer
      if (timerRef.current) {
        clearTimeout(timerRef.current)
      }
      timerRef.current = setTimeout(() => setCopied(false), 2000)
    } catch (error) {
      console.error("Failed to copy to clipboard:", error)
    }
  }, [text, triggerHaptic])

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
      }
    }
  }, [])

  return (
    <button
      onClick={handleCopy}
      tabIndex={-1}
      className="p-1.5 rounded-md transition-[background-color,transform] duration-150 ease-out hover:bg-accent active:scale-[0.97]"
    >
      <div className="relative w-3.5 h-3.5">
        <CopyIcon
          className={cn(
            "absolute inset-0 w-3.5 h-3.5 text-muted-foreground transition-[opacity,transform] duration-200 ease-out",
            copied ? "opacity-0 scale-50" : "opacity-100 scale-100",
          )}
        />
        <CheckIcon
          className={cn(
            "absolute inset-0 w-3.5 h-3.5 text-muted-foreground transition-[opacity,transform] duration-200 ease-out",
            copied ? "opacity-100 scale-100" : "opacity-0 scale-50",
          )}
        />
      </div>
    </button>
  )
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- message shape varies across providers
export function getMessageTextContent(msg: any): string {
  if (!msg?.parts) return ""
  return msg.parts
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- part shape varies
    .filter((p: any) => p.type === "text")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- part shape varies
    .map((p: any) => p.text || "")
    .join("\n")
}
