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

    const checkRef = () => {
      const element = diffSidebarRef.current
      if (!element) {
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
