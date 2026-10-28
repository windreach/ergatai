import { useEffect, useState } from "react"

interface UseDiffSidebarWidthProps {
  isDiffSidebarOpen: boolean
  storedDiffSidebarWidth: number
  diffSidebarRef: React.RefObject<HTMLDivElement | null>
}

/**
 * Hook to track diff sidebar width in real-time using ResizeObserver
 * The atom only updates after resize ends, so this provides live width updates
 */
export function useDiffSidebarWidth({
  isDiffSidebarOpen,
  storedDiffSidebarWidth,
  diffSidebarRef,
}: UseDiffSidebarWidthProps) {
  const [diffSidebarWidth, setDiffSidebarWidth] = useState(storedDiffSidebarWidth)

  useEffect(() => {
    if (!isDiffSidebarOpen) {
      return
    }

    let observer: ResizeObserver | null = null
    let rafId: number | null = null
    let retries = 0
    const MAX_RETRIES = 60 // ~1 秒 @ 60fps

    const checkRef = () => {
      const element = diffSidebarRef.current
      if (!element) {
        if (retries++ >= MAX_RETRIES) {
          console.warn('[DiffSidebarWidth] Ref not mounted after max retries')
          return
        }
        // Retry if ref not ready yet
        rafId = requestAnimationFrame(checkRef)
        return
      }

      // Set initial width
      setDiffSidebarWidth(element.offsetWidth || storedDiffSidebarWidth)

      observer = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const width = entry.contentRect.width
          if (width > 0) {
            setDiffSidebarWidth(width)
          }
        }
      })

      observer.observe(element)
    }

    checkRef()

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId)
      if (observer) observer.disconnect()
    }
  }, [isDiffSidebarOpen, storedDiffSidebarWidth, diffSidebarRef])

  return { diffSidebarWidth, setDiffSidebarWidth }
}
