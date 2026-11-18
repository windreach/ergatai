"use client"

import { memo } from "react"
import { Target } from "lucide-react"
import { cn } from "@/lib/utils"

interface GoalWidgetProps {
  goal?: unknown
}

export const GoalWidget = memo(function GoalWidget({ goal }: GoalWidgetProps) {
  if (!goal) return null
  const text =
    typeof goal === "string"
      ? goal
      : (() => {
          try {
            return JSON.stringify(goal, null, 2)
          } catch {
            return String(goal)
          }
        })()

  return (
    <div className="rounded-lg border border-border/60 bg-muted/30 p-3 text-sm">
      <div className="mb-1 flex items-center gap-2 font-medium">
        <Target className="h-4 w-4" />
        <span>Goal</span>
      </div>
      <div className="text-xs text-muted-foreground whitespace-pre-wrap">{text}</div>
    </div>
  )
})
