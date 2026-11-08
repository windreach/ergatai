"use client"

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { getDropdownDimensions } from "../ui/dropdown-sizes"

interface DropdownShellOptions {
  isOpen: boolean
  onClose: () => void
  optionCount: number
  /** Skip non-selectable items (e.g. group headers) during navigation */
  isSelectable?: (index: number) => boolean
}

interface DropdownShellResult {
  dropdownRef: React.RefObject<HTMLDivElement | null>
  selectedIndex: number
  setSelectedIndex: (index: number) => void
  placement: "above" | "below"
  finalTop: number
  finalLeft: number
  dropdownWidth: number
  computedMaxHeight: number
  transformY: string
  placeAbove: boolean
  /** Debounced search text */
  debouncedSearchText: string
}

interface Position {
  top: number
  left: number
}

interface UseDropdownPositionOptions {
  isOpen: boolean
  position: Position
  containerWidth?: number
  containerLeft?: number
  requestedHeight: number
}

function useDropdownPosition({
  isOpen,
  position,
  containerWidth,
  containerLeft,
  requestedHeight,
}: UseDropdownPositionOptions) {
  const placementRef = useRef<"above" | "below" | null>(null)
  const dimensions = getDropdownDimensions()
  const dropdownWidth = dimensions.width
  const gap = dimensions.gap
  const caretOffsetBelow = 20
  const safeMargin = 10

  const availableBelow =
    typeof window !== "undefined"
      ? window.innerHeight - (position.top + caretOffsetBelow) - safeMargin
      : 0
  const availableAbove =
    typeof window !== "undefined" ? position.top - safeMargin : 0

  // Lock placement for the duration of the open state
  const placement = useMemo(() => {
    if (!isOpen) return "below" as const
    if (placementRef.current !== null) return placementRef.current
    const condition1 =
      availableAbove >= requestedHeight && availableBelow < requestedHeight
    const condition2 =
      availableAbove > availableBelow && availableAbove >= requestedHeight
    return (condition1 || condition2 ? "above" : "below") as "above" | "below"
  }, [isOpen, availableAbove, availableBelow, requestedHeight])

  useLayoutEffect(() => {
    placementRef.current = placement
  }, [placement])

  // Reset placement when closed
  useEffect(() => {
    if (!isOpen) {
      placementRef.current = null
    }
  }, [isOpen])

  const placeAbove = placement === "above"
  const finalTop = placeAbove
    ? position.top - gap
    : position.top + gap + caretOffsetBelow

  let finalLeft = containerLeft ?? position.left
  const winWidth = typeof window !== "undefined" ? window.innerWidth : 1000
  if (finalLeft + dropdownWidth > winWidth - safeMargin) {
    finalLeft = winWidth - dropdownWidth - safeMargin
  }
  if (finalLeft < safeMargin) {
    finalLeft = safeMargin
  }

  const computedMaxHeight = Math.max(
    80,
    Math.min(requestedHeight, dimensions.maxHeight),
  )
  const transformY = placeAbove ? "translateY(-100%)" : "translateY(0)"

  return {
    placement,
    finalTop,
    finalLeft,
    dropdownWidth,
    computedMaxHeight,
    transformY,
    placeAbove,
  }
}

/**
 * Shared dropdown shell hook: extracts common behavior from dropdown components.
 *
 * Provides:
 * - Debounced search text
 * - Selected index management with keyboard navigation
 * - Placement calculation (auto-flip above/below)
 * - Auto-scroll selected item into view
 * - Click outside handling
 */
export function useDropdownShell({
  isOpen,
  onClose,
  position,
  containerWidth,
  containerLeft,
  optionCount,
  searchText,
  isSelectable,
}: DropdownShellOptions & {
  position: Position
  containerWidth?: number
  containerLeft?: number
  searchText: string
}): DropdownShellResult {
  const dropdownRef = useRef<HTMLDivElement>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [debouncedSearchText, setDebouncedSearchText] = useState(searchText)

  // Debounce search text (300ms)
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearchText(searchText)
    }, 300)
    return () => clearTimeout(timer)
  }, [searchText])

  // Track previous values for smarter selection reset
  const prevIsOpenRef = useRef(isOpen)
  const prevSearchRef = useRef(debouncedSearchText)

  // Selection management
  useLayoutEffect(() => {
    const didJustOpen = isOpen && !prevIsOpenRef.current
    const didSearchChange = debouncedSearchText !== prevSearchRef.current

    if (didJustOpen || didSearchChange) {
      setSelectedIndex(0)
    } else if (optionCount > 0 && selectedIndex >= optionCount) {
      setSelectedIndex(Math.max(0, optionCount - 1))
    }

    prevIsOpenRef.current = isOpen
    prevSearchRef.current = debouncedSearchText
  }, [isOpen, debouncedSearchText, optionCount, selectedIndex])

  // Keyboard navigation
  useEffect(() => {
    if (!isOpen || optionCount === 0) return

    const handleKeyDown = (e: KeyboardEvent) => {
      const findNextSelectable = (
        start: number,
        direction: 1 | -1,
      ): number => {
        let next = start
        for (let i = 0; i < optionCount; i++) {
          next = (next + direction + optionCount) % optionCount
          if (!isSelectable || isSelectable(next)) return next
        }
        return -1
      }

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault()
          e.stopPropagation()
          e.stopImmediatePropagation()
          {
            const next = findNextSelectable(selectedIndex, 1)
            if (next >= 0) setSelectedIndex(next)
          }
          break
        case "ArrowUp":
          e.preventDefault()
          e.stopPropagation()
          e.stopImmediatePropagation()
          {
            const next = findNextSelectable(selectedIndex, -1)
            if (next >= 0) setSelectedIndex(next)
          }
          break
        case "Escape":
          e.preventDefault()
          e.stopPropagation()
          e.stopImmediatePropagation()
          onClose()
          break
      }
    }

    window.addEventListener("keydown", handleKeyDown, { capture: true })
    return () =>
      window.removeEventListener("keydown", handleKeyDown, { capture: true })
  }, [isOpen, optionCount, selectedIndex, isSelectable, onClose])

  // Auto-scroll selected item into view
  useEffect(() => {
    if (!isOpen || !dropdownRef.current) return

    if (selectedIndex === 0) {
      dropdownRef.current.scrollTo({ top: 0, behavior: "auto" })
      return
    }

    const elements = dropdownRef.current.querySelectorAll("[data-option-index]")
    const selectedElement = elements[selectedIndex] as HTMLElement
    if (selectedElement) {
      selectedElement.scrollIntoView({ block: "nearest" })
    }
  }, [selectedIndex, isOpen])

  // Click outside
  useEffect(() => {
    if (!isOpen) return

    const handleClickOutside = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node)
      ) {
        onClose()
      }
    }

    document.addEventListener("mousedown", handleClickOutside)
    return () => document.removeEventListener("mousedown", handleClickOutside)
  }, [isOpen, onClose])

  // Calculate requested height for position calculation
  const dimensions = getDropdownDimensions()
  const requestedHeight = Math.min(
    optionCount * dimensions.itemHeight + dimensions.gap,
    dimensions.maxHeight,
  )

  const positionResult = useDropdownPosition({
    isOpen,
    position,
    containerWidth,
    containerLeft,
    requestedHeight,
  })

  return {
    dropdownRef,
    selectedIndex,
    setSelectedIndex,
    ...positionResult,
    debouncedSearchText,
  }
}

/**
 * Common dropdown container styles.
 */
export function getDropdownContainerStyle(
  finalTop: number,
  finalLeft: number,
  computedMaxHeight: number,
  transformY: string,
  containerWidth?: number,
  dropdownWidth?: number,
): React.CSSProperties {
  return {
    top: finalTop,
    left: finalLeft,
    width: containerWidth ? `${containerWidth}px` : `${dropdownWidth ?? 320}px`,
    maxHeight: `${computedMaxHeight}px`,
    transform: transformY,
    transformOrigin: transformY.includes("-100%") ? "bottom" : "top",
  }
}
