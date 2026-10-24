import { useEffect, useRef } from "react"

interface MessageGroupProps {
  children: React.ReactNode
  isLastGroup?: boolean
}

/**
 * Measures the user message height for sticky todo positioning and optimizes
 * offscreen groups. The last group stays fully laid out while it streams.
 */
export function MessageGroup({ children, isLastGroup }: MessageGroupProps) {
  const groupRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const groupEl = groupRef.current
    if (!groupEl) return

    // Find the actual bubble element (not the wrapper which includes gradient)
    const bubbleEl = groupEl.querySelector('[data-user-bubble]') as HTMLDivElement | null
    if (!bubbleEl) return

    const updateHeight = () => {
      groupEl.style.setProperty('--user-message-height', `${bubbleEl.offsetHeight}px`)
    }

    updateHeight()

    const observer = new ResizeObserver(updateHeight)
    observer.observe(bubbleEl)

    return () => observer.disconnect()
  }, [])

  return (
    <div
      ref={groupRef}
      className="relative"
      style={{
        ...(!isLastGroup && {
          contentVisibility: "auto",
          containIntrinsicSize: "auto 200px",
        }),
        ...(isLastGroup && { minHeight: "calc(var(--chat-container-height) - 32px)" }),
      }}
      data-last-group={isLastGroup || undefined}
    >
      {children}
    </div>
  )
}
