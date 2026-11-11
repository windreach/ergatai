"use client"

import { cn } from "../../../lib/utils"
import { trpc } from "../../../lib/trpc"
import {
  useEffect,
  useMemo,
  memo,
} from "react"
import { createPortal } from "react-dom"
import type { SlashCommandOption } from "./types"
import type { AgentMode } from "../atoms"
import { useDiscoveryGroups } from "../discovery/use-discovery-groups"
import { useDropdownShell, getDropdownContainerStyle } from "../discovery/use-dropdown-shell"

interface AgentsSlashCommandProps {
  isOpen: boolean
  onClose: () => void
  onSelect: (command: SlashCommandOption) => void
  searchText: string
  position: { top: number; left: number }
  containerWidth?: number
  containerLeft?: number
  chatId?: string
  cwd?: string
  mode?: AgentMode
  disabledCommands?: string[]
  agentKind?: string
}

// Memoized to prevent re-renders when parent re-renders
// react-doctor-disable-next-line no-high-complexity-react-function
// react-doctor-disable-next-line no-giant-component
export const AgentsSlashCommand = memo(function AgentsSlashCommand({
  isOpen,
  onClose,
  onSelect,
  searchText,
  position,
  containerWidth,
  containerLeft,
  chatId,
  cwd,
  mode,
  disabledCommands,
  agentKind,
}: AgentsSlashCommandProps) {
  // Fetch agent bindings to get the agentId for the current chat
  const { data: bindings } = trpc.ergatai.getAgentBindings.useQuery(
    { chatId: chatId ?? "" },
    {
      enabled: isOpen && !!chatId,
      staleTime: 60_000, // Cache for 1 minute - bindings don't change often
    },
  )

  // Use the first binding's agentId (or the one matching the chat)
  const agentId = bindings?.[0]?.agentId

  // Generic discovery aggregation (shared abstraction for trigger dropdowns).
  const { groups: discoveryGroups, isLoading: discoveryLoading } = useDiscoveryGroups(isOpen ? agentId : undefined, cwd, agentKind)

  const agentCommands: SlashCommandOption[] = useMemo(() => {
    return discoveryGroups.flatMap((g) =>
      g.items.map((it) => ({
        id: `${it.source ?? "agent"}:${it.name}`,
        name: it.name,
        command: `/${it.name}`,
        description: it.description || "",
        category: "agent" as const,
        group: g.id,
      })),
    )
  }, [discoveryGroups])

  // Filter options with raw searchText for option count (used by shell for keyboard nav)
  const filteredOptions: SlashCommandOption[] = useMemo(() => {
    if (!searchText) return agentCommands
    const query = searchText.toLowerCase()
    return agentCommands.filter(
      (cmd) =>
        cmd.name.toLowerCase().includes(query) ||
        cmd.command.toLowerCase().includes(query),
    )
  }, [searchText, agentCommands])

  // Shared dropdown shell (keyboard nav, placement, auto-scroll, click outside, debounce)
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
    optionCount: filteredOptions.length,
    searchText,
  })

  // Re-filter with debounced text for display (smoother UX during typing)
  const displayOptions: SlashCommandOption[] = useMemo(() => {
    if (!debouncedSearchText) return agentCommands
    const query = debouncedSearchText.toLowerCase()
    return agentCommands.filter(
      (cmd) =>
        cmd.name.toLowerCase().includes(query) ||
        cmd.command.toLowerCase().includes(query),
    )
  }, [debouncedSearchText, agentCommands])

  // Enter/Tab selection (shell handles Escape/Arrow)
  useEffect(() => {
    if (!isOpen) return

    const handleSelect_key = (e: KeyboardEvent) => {
      switch (e.key) {
        case "Enter":
          if (e.shiftKey) return
          e.preventDefault()
          e.stopPropagation()
          e.stopImmediatePropagation()
          if (displayOptions[selectedIndex]) {
            onSelect(displayOptions[selectedIndex])
          }
          break
        case "Tab":
          e.preventDefault()
          e.stopPropagation()
          e.stopImmediatePropagation()
          if (displayOptions[selectedIndex]) {
            onSelect(displayOptions[selectedIndex])
          }
          break
      }
    }

    window.addEventListener("keydown", handleSelect_key, { capture: true })
    return () =>
      window.removeEventListener("keydown", handleSelect_key, { capture: true })
  }, [isOpen, displayOptions, selectedIndex, onSelect])

  // Do not keep an empty dropdown open when there is no search text and no available items.
  useEffect(() => {
    if (!isOpen) return
    if (debouncedSearchText) return
    if (discoveryLoading) return
    if (filteredOptions.length === 0) {
      onClose()
    }
  }, [isOpen, debouncedSearchText, discoveryLoading, filteredOptions.length, onClose])

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
      {/* Grouped commands by source/group */}
      {displayOptions.length > 0 && (
        <>
          {Array.from(new Set(displayOptions.map((o) => o.group || "commands"))).map((group) => (
            <div key={group}>
              <div className="px-2.5 py-1.5 mx-1 text-xs font-bold text-muted-foreground">
                {group}
              </div>
              {displayOptions
                .filter((option) => (option.group || "commands") === group)
                .map((option) => {
                  const index = displayOptions.indexOf(option)
                  const isSelected = selectedIndex === index
                  return (
                    <div
                      // react-doctor-disable-next-line prefer-tag-over-role
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault()
                          ;(e.currentTarget as HTMLElement).click()
                        }
                      }}
                      key={option.id}
                      data-option-index={index}
                      onMouseDown={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        onSelect(option)
                      }}
                      onMouseEnter={() => setSelectedIndex(index)}
                      className={cn(
                        "group inline-flex w-[calc(100%-8px)] mx-1 items-center whitespace-nowrap outline-none",
                        "h-7 px-1.5 justify-start text-xs rounded-md",
                        "transition-colors cursor-pointer select-none",
                        isSelected
                          ? "dark:bg-neutral-800 bg-accent text-foreground"
                          : "text-muted-foreground dark:hover:bg-neutral-800 hover:bg-accent hover:text-foreground",
                      )}
                    >
                      <span className="flex items-center gap-1 w-full min-w-0">
                        <span className="shrink-0 whitespace-nowrap font-medium">
                          {option.command}
                        </span>
                        <span
                          className="text-muted-foreground flex-1 min-w-0 ml-2 overflow-hidden text-[10px] truncate"
                        >
                          {option.description}
                        </span>
                      </span>
                    </div>
                  )
                })}
            </div>
          ))}
        </>
      )}

      {/* Empty state */}
      {displayOptions.length === 0 && (
        <div className="h-7 px-1.5 mx-1 flex items-center text-xs text-muted-foreground">
          {debouncedSearchText
            ? `No commands matching "${debouncedSearchText}"`
            : "No commands available"}
        </div>
      )}
    </div>,
    document.body
  )
})
