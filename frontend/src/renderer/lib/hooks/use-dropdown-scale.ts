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
  const computeScale = (width: number) => {
    return Math.min(1.5, Math.max(0.85, width / 800))
  }

  const [scale, setScale] = React.useState<number>(() => {
    if (typeof window === "undefined") return 1.0
    return computeScale(window.innerWidth)
  })

  React.useEffect(() => {
    const updateScale = () => {
      setScale(computeScale(window.innerWidth))
    }

    window.addEventListener("resize", updateScale)
    updateScale()

    return () => window.removeEventListener("resize", updateScale)
  }, [])

  return scale
}
