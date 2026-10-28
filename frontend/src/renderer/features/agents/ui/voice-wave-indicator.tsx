"use client"

import { memo, useEffect, useRef } from "react"
import { cn } from "../../../lib/utils"

// Module-level constants for wave visualization
const BAR_CENTER_FACTORS = [0.45, 0.7, 1, 0.7, 0.45]
const BAR_BASE_HEIGHT = 10
const BAR_MAX_HEIGHT = 100
const BAR_RANDOM_MIN = 0.9
const BAR_RANDOM_RANGE = 0.2
const BAR_RESET_HEIGHT = 15

interface VoiceWaveIndicatorProps {
  isRecording: boolean
  audioLevel: number // 0-1 normalized audio level
  className?: string
}

/**
 * Animated sound wave indicator that visualizes audio input
 * Shows animated bars that respond to real audio levels
 */
export const VoiceWaveIndicator = memo(function VoiceWaveIndicator({
  isRecording,
  audioLevel,
  className,
}: VoiceWaveIndicatorProps) {
  const barsRef = useRef<(HTMLDivElement | null)[]>([])

  useEffect(() => {
    if (!isRecording) {
      // Reset bar heights when not recording
      barsRef.current.forEach((bar) => {
        if (bar) bar.style.height = `${BAR_RESET_HEIGHT}%`
      })
      return
    }

    // Update bars based on audio level
    // Create a natural wave pattern with slight variations
    barsRef.current.forEach((bar, index) => {
      if (!bar) return

      // Create wave pattern - center bars are taller, edges noticeably shorter
      const centerFactor = BAR_CENTER_FACTORS[index] ?? 1

      // Add slight randomness for organic feel
      const randomVariation = BAR_RANDOM_MIN + Math.random() * BAR_RANDOM_RANGE

      // Calculate height: minimum BAR_BASE_HEIGHT%, scale up to BAR_MAX_HEIGHT% based on audio level
      const levelHeight = audioLevel * (BAR_MAX_HEIGHT - BAR_BASE_HEIGHT) * centerFactor * randomVariation
      const finalHeight = BAR_BASE_HEIGHT + levelHeight

      bar.style.height = `${finalHeight}%`
    })
  }, [isRecording, audioLevel])

  if (!isRecording) return null

  return (
    <div
      className={cn(
        "flex items-center justify-center gap-[3px] h-5 px-2",
        className
      )}
    >
      {[0, 1, 2, 3, 4].map((i) => (
        <div
          key={i}
          ref={(el) => {
            if (el) {
              barsRef.current[i] = el
            } else {
              barsRef.current[i] = null
            }
          }}
          className="w-[3px] bg-foreground rounded-full transition-[height] duration-75 ease-out"
          style={{ height: `${BAR_RESET_HEIGHT}%` }}
        />
      ))}
    </div>
  )
})
