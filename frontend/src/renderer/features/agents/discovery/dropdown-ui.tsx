"use client"

import { createPortal } from "react-dom"
import type {
  CSSProperties,
  HTMLAttributes,
  KeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
  RefObject,
} from "react"
import { cn } from "../../../lib/utils"
import { isImeComposing } from "../mentions/mentions-utils"
import { getDropdownContainerStyle } from "./use-dropdown-shell"

interface DropdownPanelProps {
  dropdownRef: RefObject<HTMLDivElement | null>
  finalTop: number
  finalLeft: number
  computedMaxHeight: number
  transformY: string
  containerWidth?: number
  dropdownWidth?: number
  children: ReactNode
}

/**
 * Shared portal panel for all composer dropdowns (mentions, skills, references
 * and slash commands) so sizing, scrolling and surfaces stay identical.
 */
export function DropdownPanel({
  dropdownRef,
  finalTop,
  finalLeft,
  computedMaxHeight,
  transformY,
  containerWidth,
  dropdownWidth,
  children,
}: DropdownPanelProps) {
  return createPortal(
    <div
      ref={dropdownRef}
      className="fixed z-[99999] overflow-y-auto rounded-[10px] border border-border bg-popover py-1 text-xs text-popover-foreground shadow-lg [&::-webkit-scrollbar]:hidden"
      style={{
        ...getDropdownContainerStyle(
          finalTop,
          finalLeft,
          computedMaxHeight,
          transformY,
          containerWidth,
          dropdownWidth,
        ),
        scrollbarWidth: "none",
        msOverflowStyle: "none",
      } as CSSProperties}
    >
      {children}
    </div>,
    document.body,
  )
}

interface DropdownSectionHeaderProps extends HTMLAttributes<HTMLDivElement> {
  /** Keeps keyboard navigation and auto-scroll index mapping intact. */
  optionIndex?: number
}

/**
 * Shared section/group title. Composer dropdowns must not invent their own
 * weights or colors for group headings.
 */
export function DropdownSectionHeader({
  optionIndex,
  className,
  children,
  ...props
}: DropdownSectionHeaderProps) {
  return (
    <div
      data-option-index={optionIndex}
      className={cn(
        "px-2.5 py-1.5 mx-1 text-xs font-medium text-muted-foreground",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  )
}

interface DropdownOptionProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "onSelect"> {
  optionIndex: number
  selected?: boolean
  /** Select on mousedown to keep the editor focused (skills/commands). */
  selectOnMouseDown?: boolean
  onSelect: () => void
}

/**
 * Shared selectable row for composer dropdowns. Keeps hover/selected states,
 * typography and keyboard activation consistent across all trigger types.
 */
export function DropdownOption({
  optionIndex,
  selected = false,
  selectOnMouseDown = false,
  onSelect,
  className,
  children,
  onKeyDown,
  onClick,
  onMouseDown,
  ...props
}: DropdownOptionProps) {
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event)
    if (event.defaultPrevented) return
    if (isImeComposing(event.nativeEvent)) return
    if (event.key === "Enter" && event.shiftKey) return
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault()
      onSelect()
    }
  }

  const handleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    onClick?.(event)
    if (event.defaultPrevented || selectOnMouseDown) return
    onSelect()
  }

  const handleMouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
    onMouseDown?.(event)
    if (event.defaultPrevented || !selectOnMouseDown) return
    event.preventDefault()
    event.stopPropagation()
    onSelect()
  }

  return (
    <div
      // react-doctor-disable-next-line prefer-tag-over-role
      role="button"
      tabIndex={0}
      data-option-index={optionIndex}
      onKeyDown={handleKeyDown}
      onClick={handleClick}
      onMouseDown={handleMouseDown}
      className={cn(
        "group inline-flex w-[calc(100%-8px)] mx-1 items-center whitespace-nowrap outline-none",
        "h-7 px-1.5 justify-start text-xs rounded-md transition-colors cursor-pointer select-none",
        selected
          ? "dark:bg-neutral-800 bg-accent text-foreground"
          : "text-muted-foreground dark:hover:bg-neutral-800 hover:bg-accent hover:text-foreground",
        className,
      )}
      {...props}
    >
      <span className="flex items-center gap-1 w-full min-w-0">{children}</span>
    </div>
  )
}

export function DropdownEmptyState({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "h-7 px-1.5 mx-1 flex items-center text-xs text-muted-foreground",
        className,
      )}
    >
      {children}
    </div>
  )
}