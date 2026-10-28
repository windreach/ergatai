"use client"

import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { Button } from "../../../components/ui/button"
import {
  LinkIcon,
  CheckIcon,
} from "../../../components/ui/icons"
import { cn } from "../../../lib/utils"
import { useHaptic } from "../hooks/use-haptic"

interface MobileCopyLinkButtonProps {
  url: string
}

export function MobileCopyLinkButton({ url }: MobileCopyLinkButtonProps) {
  const [copied, setCopied] = useState(false)
  const { trigger: triggerHaptic } = useHaptic()
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  const handleCopy = async () => {
    try {
      // Feature detection: check if Clipboard API is available
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(url)
      } else {
        // Fallback: use legacy execCommand method
        const textArea = document.createElement("textarea")
        textArea.value = url
        textArea.style.position = "fixed"
        textArea.style.left = "-999999px"
        document.body.appendChild(textArea)
        textArea.select()

        try {
          document.execCommand("copy")
        } finally {
          document.body.removeChild(textArea)
        }
      }

      triggerHaptic("medium")
      setCopied(true)
      // Clear any existing timer before setting a new one
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setCopied(false), 2000)
    } catch (error) {
      console.error("Failed to copy:", error)
      toast.error("Failed to copy link")
    }
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={handleCopy}
      className="h-7 w-7 p-0 hover:bg-foreground/10 transition-[background-color,transform] duration-150 ease-out active:scale-[0.97] flex-shrink-0 rounded-md"
    >
      <div className="relative w-3.5 h-3.5">
        <LinkIcon
          className={cn(
            "absolute inset-0 w-3.5 h-3.5 transition-[opacity,transform] duration-200 ease-out",
            copied ? "opacity-0 scale-50" : "opacity-100 scale-100",
          )}
        />
        <CheckIcon
          className={cn(
            "absolute inset-0 w-3.5 h-3.5 transition-[opacity,transform] duration-200 ease-out",
            copied ? "opacity-100 scale-100" : "opacity-0 scale-50",
          )}
        />
      </div>
      <span className="sr-only">{copied ? "Copied!" : "Copy link"}</span>
    </Button>
  )
}
