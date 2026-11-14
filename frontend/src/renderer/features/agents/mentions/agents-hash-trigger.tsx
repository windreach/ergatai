"use client"

import { cn } from "../../../lib/utils"
import { useEffect, useMemo, memo } from "react"
import { createPortal } from "react-dom"
import type { FileMentionOption } from "./agents-mentions-editor"
import { MENTION_PREFIXES } from "./mentions-utils"
import { useDropdownShell, getDropdownContainerStyle } from "../discovery/use-dropdown-shell"

interface ChangedFile {
  filePath: string
  displayPath: string
  additions: number
  deletions: number
}

interface AgentsHashTriggerProps {
  isOpen: boolean
  onClose: () => void
  onSelect: (mention: FileMentionOption) => void
  searchText: string
  position: { top: number; left: number }
  containerWidth?: number
  containerLeft?: number
  changedFiles?: ChangedFile[]
}

/**
 * `#` trigger: reference picker (self-built grammar).
 * Currently surfaces changed files as references; can be extended to issues/PRs/tasks.
 */
export const AgentsHashTrigger = memo(function AgentsHashTrigger({
  isOpen,
  onClose,
  onSelect,
  searchText,
  position,
  containerWidth,
  containerLeft,
  changedFiles = [],
}: AgentsHashTriggerProps) {
  const options = useMemo<FileMentionOption[]>(() => {
    const q = searchText.trim().toLowerCase()
    return changedFiles
      .filter((f) => !q || f.displayPath.toLowerCase().includes(q) || f.filePath.toLowerCase().includes(q))
      .map((f) => ({
        id: `${MENTION_PREFIXES.FILE}${f.filePath}`,
        label: f.displayPath.split("/").pop() || f.displayPath,
        path: f.filePath,
        repository: "",
        type: "file" as const,
        group: "References (#)",
        description: f.displayPath,
        additions: f.additions,
        deletions: f.deletions,
      }))
  }, [changedFiles, searchText])

  const {
    dropdownRef,
    selectedIndex,
    debouncedSearchText,
    setSelectedIndex,
    finalTop,
    finalLeft,
    dropdownWidth,
    computedMaxHeight,
    transformY,
  } = useDropdownShell({
    isOpen,
    onClose,
    position,
    containerWidth,
    containerLeft,
    optionCount: options.length,
    searchText,
  })

  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" && e.key !== "Tab") return
      if (e.key === "Enter" && e.shiftKey) return
      e.preventDefault()
      e.stopPropagation()
      e.stopImmediatePropagation()
      const opt = options[selectedIndex]
      if (opt) onSelect(opt)
    }
    window.addEventListener("keydown", onKey, { capture: true })
    return () => window.removeEventListener("keydown", onKey, { capture: true })
  }, [isOpen, options, selectedIndex, onSelect])

  useEffect(() => {
    if (!isOpen || debouncedSearchText || options.length > 0) return
    onClose()
  }, [isOpen, debouncedSearchText, options.length, onClose])

  if (!isOpen) return null

  return createPortal(
    <div
      ref={dropdownRef}
      className="fixed z-[99999] overflow-y-auto rounded-[10px] border border-border bg-popover py-1 text-xs text-popover-foreground shadow-lg [&::-webkit-scrollbar]:hidden"
      style={{
        ...getDropdownContainerStyle(finalTop, finalLeft, computedMaxHeight, transformY, containerWidth, dropdownWidth),
        scrollbarWidth: "none",
        msOverflowStyle: "none",
      } as React.CSSProperties}
    >
      {options.length > 0 ? (
        <>
          <div className="px-2.5 py-1.5 mx-1 text-xs font-bold text-muted-foreground">References (#)</div>
          {options.map((option, index) => (
            <div
              role="button"
              tabIndex={0}
              key={option.id}
              data-option-index={index}
              onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); onSelect(option) }}
              onMouseEnter={() => setSelectedIndex(index)}
              className={cn(
                "group inline-flex w-[calc(100%-8px)] mx-1 items-center whitespace-nowrap outline-none",
                "h-7 px-1.5 justify-start text-xs rounded-md transition-colors cursor-pointer select-none",
                selectedIndex === index ? "dark:bg-neutral-800 bg-accent text-foreground" : "text-muted-foreground dark:hover:bg-neutral-800 hover:bg-accent hover:text-foreground",
              )}
            >
              <span className="flex items-center gap-1 w-full min-w-0">
                <span className="shrink-0 whitespace-nowrap font-medium">#{option.label}</span>
                {option.description && <span className="text-muted-foreground flex-1 min-w-0 ml-2 overflow-hidden text-[10px] truncate">{option.description}</span>}
              </span>
            </div>
          ))}
        </>
      ) : (
        <div className="h-7 px-1.5 mx-1 flex items-center text-xs text-muted-foreground">
          {debouncedSearchText ? `No references matching "${debouncedSearchText}"` : "No references available"}
        </div>
      )}
    </div>,
    document.body,
  )
})
