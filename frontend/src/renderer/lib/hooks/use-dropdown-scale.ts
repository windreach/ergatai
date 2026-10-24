import * as React from "react"

/**
 * Hook to get dynamic scale factor for dropdowns based on window size
 *
 * Scale factors:
 * - width < 600px: 0.85 (85%)
 * - width < 800px: 0.9 (90%)
 * - width >= 800px: 1.0 (100%)
 */
export function useDropdownScale(): number {
  const [scale, setScale] = React.useState<number>(() => {
    if (typeof window === "undefined") return 1.0
    const width = window.innerWidth
    if (width < 600) return 0.85
    if (width < 800) return 0.9
    return 1.0
  })

  React.useEffect(() => {
    const updateScale = () => {
      const width = window.innerWidth
      if (width < 600) {
        setScale(0.85)
      } else if (width < 800) {
        setScale(0.9)
      } else {
        setScale(1.0)
      }
    }

    // Listen to window resize
    window.addEventListener("resize", updateScale)
    updateScale() // Initial check

    return () => window.removeEventListener("resize", updateScale)
  }, [])

  return scale
}
