"use client"

import { cn } from "../../../lib/utils"
import { Monitor, Smartphone, type LucideIcon } from "lucide-react"
import { motion } from "motion/react"

interface ViewportToggleProps {
  value: "desktop" | "mobile"
  onChange: (mode: "desktop" | "mobile") => void
  className?: string
}

type ViewportMode = "desktop" | "mobile"

interface ViewportOption {
  mode: ViewportMode
  Icon: LucideIcon
  label: string
}

const VIEWPORT_OPTIONS: readonly ViewportOption[] = [
  { mode: "desktop", Icon: Monitor, label: "Desktop viewport" },
  { mode: "mobile", Icon: Smartphone, label: "Mobile viewport" },
] as const

const buttonClassName =
  "relative z-[2] px-2 flex-1 flex items-center justify-center transition-colors duration-200 rounded-md outline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring/70 text-muted-foreground"

export function ViewportToggle({
  value,
  onChange,
  className,
}: ViewportToggleProps) {
  return (
    <motion.div
      layout
      className={cn("flex items-center", className)}
      transition={{
        layout: {
          duration: 0.15,
          ease: "easeInOut",
        },
      }}
    >
      <motion.div
        layout
        className="relative bg-muted rounded-lg h-7 p-0.5 flex"
      >
        {/* Animated selector */}
        <motion.div
          className="absolute inset-y-0.5 rounded-md bg-background shadow transition-all duration-200 ease-in-out"
          animate={{
            width: "calc(50% - 2px)",
            left: value === "desktop" ? "2px" : "calc(50%)",
          }}
          transition={{
            duration: 0.2,
            ease: "easeInOut",
          }}
        />
        {VIEWPORT_OPTIONS.map(({ mode, Icon, label }) => (
          <button
            key={mode}
            type="button"
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              onChange(mode)
            }}
            aria-label={label}
            aria-pressed={value === mode}
            className={buttonClassName}
          >
            <Icon className="h-3.5 w-3.5" />
          </button>
        ))}
      </motion.div>
    </motion.div>
  )
}
