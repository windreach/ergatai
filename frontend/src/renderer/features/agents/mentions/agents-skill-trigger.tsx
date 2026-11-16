"use client"

import { useEffect, useMemo, memo } from "react"
import type { FileMentionOption } from "./agents-mentions-editor"
import { MENTION_PREFIXES } from "./mentions-utils"
import { useDiscoveryGroups } from "../discovery/use-discovery-groups"
import { useDropdownShell } from "../discovery/use-dropdown-shell"
import { MentionTriggerDropdown } from "./mention-trigger-dropdown"

interface AgentsSkillTriggerProps {
  isOpen: boolean
  onClose: () => void
  onSelect: (mention: FileMentionOption) => void
  searchText: string
  position: { top: number; left: number }
  containerWidth?: number
  containerLeft?: number
  agentId?: string
  cwd?: string
  agentKind?: string
}

/**
 * `$` trigger: skill/template picker (self-built grammar, agent provides capabilities).
 */
export const AgentsSkillTrigger = memo(function AgentsSkillTrigger({
  isOpen,
  onClose,
  onSelect,
  searchText,
  position,
  containerWidth,
  containerLeft,
  agentId,
  cwd,
  agentKind,
}: AgentsSkillTriggerProps) {
  const { groups, isLoading } = useDiscoveryGroups(isOpen ? agentId : undefined, cwd, agentKind)

  const options = useMemo<FileMentionOption[]>(() => {
    const q = searchText.trim().toLowerCase()
    const out: FileMentionOption[] = []
    for (const g of groups) {
      for (const item of g.items) {
        // Routing is authoritative via backend-stamped targetTriggers.
        if (!item.targetTriggers?.includes("$")) continue
        // $ trigger is primarily for skills/templates (keep a narrow, stable set).
        if (item.type !== "skill" && item.type !== "command") continue
        if (q && !item.name.toLowerCase().includes(q) && !(item.description || "").toLowerCase().includes(q)) continue
        const prefix =
          item.type === "skill" ? MENTION_PREFIXES.SKILL :
          MENTION_PREFIXES.COMMAND
        out.push({
          id: `${prefix}${item.name}`,
          label: item.name,
          path: item.name,
          repository: "",
          type: item.type,
          group: g.label || g.id,
          description: item.description || "",
        })
      }
    }
    return out
  }, [groups, searchText])

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
    if (!isOpen || debouncedSearchText || isLoading || options.length > 0) return
    onClose()
  }, [isOpen, debouncedSearchText, isLoading, options.length, onClose])

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
      header="Skills & Templates ($)"
      prefix="$"
      noun="skills"
      debouncedSearchText={debouncedSearchText}
    />
  )
})
