"use client"

import { cn } from "../../../lib/utils"
import { useEffect, useMemo, memo } from "react"
import { createPortal } from "react-dom"
import type { FileMentionOption } from "./agents-mentions-editor"
import { MENTION_PREFIXES } from "./mentions-utils"
import { useDiscoveryGroups } from "../discovery/use-discovery-groups"
import { useRegisteredTriggers } from "../discovery/use-registered-triggers"
import { useDropdownShell, getDropdownContainerStyle } from "../discovery/use-dropdown-shell"

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
  const { getTriggerTypes } = useRegisteredTriggers(isOpen ? agentId : undefined, cwd)

  const options = useMemo<FileMentionOption[]>(() => {
    const q = searchText.trim().toLowerCase()
    const allowedFallback = new Set(getTriggerTypes("$").length ? getTriggerTypes("$") : ["skill"])
    const out: FileMentionOption[] = []
    for (const g of groups) {
      for (const item of g.items) {
        // Prefer deterministic routing markers stamped at read/discovery time.
        const targeted = item.targetTriggers?.includes("$")
        const fallbackByType = !item.targetTriggers?.length && allowedFallback.has(item.type)
        if (!targeted && !fallbackByType) continue
        // $ trigger is primarily for skills/templates (keep a narrow, stable set).
        if (item.type !== "skill" && !(targeted && (item.type === "command" || item.type === "plugin"))) continue
        if (q && !item.name.toLowerCase().includes(q) && !(item.description || "").toLowerCase().includes(q)) continue
        const prefix =
          item.type === "skill" ? MENTION_PREFIXES.SKILL :
          item.type === "command" ? MENTION_PREFIXES.COMMAND :
          MENTION_PREFIXES.PLUGIN
        out.push({
          id: `${prefix}${item.name}`,
          label: item.name,
          path: item.name,
          repository: "",
          type: item.type === "skill" ? "skill" : item.type === "command" ? "command" : "plugin",
          group: g.label || g.id,
          description: item.description || "",
        })
      }
    }
    return out
  }, [groups, getTriggerTypes, searchText])

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
          <div className="px-2.5 py-1.5 mx-1 text-xs font-bold text-muted-foreground">Skills & Templates ($)</div>
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
                <span className="shrink-0 whitespace-nowrap font-medium">${option.label}</span>
                {option.description && <span className="text-muted-foreground flex-1 min-w-0 ml-2 overflow-hidden text-[10px] truncate">{option.description}</span>}
              </span>
            </div>
          ))}
        </>
      ) : (
        <div className="h-7 px-1.5 mx-1 flex items-center text-xs text-muted-foreground">
          {debouncedSearchText ? `No skills matching "${debouncedSearchText}"` : "No skills available"}
        </div>
      )}
    </div>,
    document.body,
  )
})
