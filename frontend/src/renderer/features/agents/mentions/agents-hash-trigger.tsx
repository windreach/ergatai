"use client"

import { useEffect, useMemo, memo } from "react"
import type { FileMentionOption } from "./agents-mentions-editor"
import { MENTION_PREFIXES } from "./mentions-utils"
import { useDropdownShell } from "../discovery/use-dropdown-shell"
import { MentionTriggerDropdown } from "./mention-trigger-dropdown"

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
const EMPTY_CHANGED_FILES: ChangedFile[] = []

export const AgentsHashTrigger = memo(function AgentsHashTrigger({
  isOpen,
  onClose,
  onSelect,
  searchText,
  position,
  containerWidth,
  containerLeft,
  changedFiles = EMPTY_CHANGED_FILES,
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

  return (
    <MentionTriggerDropdown
      dropdownRef={dropdownRef}
      finalTop={finalTop}
      finalLeft={finalLeft}
      computedMaxHeight={computedMaxHeight}
      transformY={transformY}
      containerWidth={containerWidth}
      dropdownWidth={dropdownWidth}
      options={options}
      selectedIndex={selectedIndex}
      setSelectedIndex={setSelectedIndex}
      onSelect={onSelect}
      header="References (#)"
      prefix="#"
      noun="references"
      debouncedSearchText={debouncedSearchText}
    />
  )
})
