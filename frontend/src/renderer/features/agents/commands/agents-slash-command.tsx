// Modified from 1Code (Apache-2.0) by Ergatai — see MODIFICATIONS.md
import i18n from "@/lib/i18n"
"use client"

import { trpc } from "../../../lib/trpc"
import {
  useEffect,
  useMemo,
  memo,
} from "react"
import type { SlashCommandOption } from "./types"
import type { AgentMode } from "../atoms"
import { useDiscoveryGroups } from "../discovery/use-discovery-groups"
import { useDropdownShell } from "../discovery/use-dropdown-shell"
import { isImeComposing } from "../mentions/mentions-utils"
import {
  DropdownEmptyState,
  DropdownOption,
  DropdownPanel,
  DropdownSectionHeader,
} from "../discovery/dropdown-ui"

interface AgentsSlashCommandProps {
  isOpen: boolean
  onClose: () => void
  onSelect: (command: SlashCommandOption) => void
  searchText: string
  position: { top: number; left: number }
  containerWidth?: number
  containerLeft?: number
  chatId?: string
  /** Runtime agent ID (preferred over resolving via chat bindings). */
  agentId?: string | null
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
  agentId: agentIdProp,
  cwd,
  mode,
  disabledCommands,
  agentKind,
}: AgentsSlashCommandProps) {
  // Fetch agent bindings to get the agentId for the current chat
  const { data: bindings, isLoading: bindingsLoading } = trpc.ergatai.getAgentBindings.useQuery(
    { chatId: chatId ?? "" },
    {
      enabled: isOpen && !!chatId && !agentIdProp,
      staleTime: 60_000, // Cache for 1 minute - bindings don't change often
    },
  )

  // Prefer the explicitly provided runtime agentId; fall back to chat bindings.
  const agentId = agentIdProp ?? bindings?.[0]?.agentId

  // Generic discovery aggregation (shared abstraction for trigger dropdowns).
  const { groups: discoveryGroups, isLoading: discoveryLoading } = useDiscoveryGroups(isOpen ? agentId : undefined, cwd, agentKind)

  const agentCommands: SlashCommandOption[] = useMemo(() => {
    return discoveryGroups.flatMap((g) =>
      g.items
        .filter((it) => {
          // Routing is authoritative via backend-stamped targetTriggers.
          return it.targetTriggers?.includes("/") === true
        })
        .map((it) => ({
          id: `${it.source ?? "agent"}:${it.name}`,
          name: it.name,
          command: it.name.startsWith("$") ? it.name : `/${it.name}`,
          description: it.description || "",
          category: "agent" as const,
          group: g.id,
          serverId: (it as { serverId?: string | number }).serverId,
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
      if (isImeComposing(e)) return
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
    // Wait for an async agent binding (if any) before deciding there are no commands.
    if (!agentId && bindingsLoading) return
    if (filteredOptions.length === 0) {
      onClose()
    }
  }, [isOpen, debouncedSearchText, discoveryLoading, filteredOptions.length, onClose, agentId, bindingsLoading])

  if (!isOpen) return null

  return (
    <DropdownPanel
      dropdownRef={dropdownRef}
      finalTop={finalTop}
      finalLeft={finalLeft}
      computedMaxHeight={computedMaxHeight}
      transformY={transformY}
      containerWidth={containerWidth}
      dropdownWidth={dropdownWidth}
    >
      {/* Grouped commands by source/group */}
      {displayOptions.length > 0 && (
        <>
          {Array.from(new Set(displayOptions.map((o) => o.group || "commands"))).map((group) => (
            <div key={group}>
              <DropdownSectionHeader>{group}</DropdownSectionHeader>
              {displayOptions
                .filter((option) => (option.group || "commands") === group)
                .map((option) => {
                  const index = displayOptions.indexOf(option)
                  const isSelected = selectedIndex === index
                  return (
                    <DropdownOption
                      key={option.id}
                      optionIndex={index}
                      selected={isSelected}
                      selectOnMouseDown
                      onSelect={() => onSelect(option)}
                      onMouseEnter={() => setSelectedIndex(index)}
                    >
                      <span className="shrink-0 whitespace-nowrap font-medium">
                        {option.command}
                      </span>
                      <span
                        className="text-muted-foreground flex-1 min-w-0 ml-2 overflow-hidden text-[10px] truncate"
                      >
                        {option.description}
                      </span>
                    </DropdownOption>
                  )
                })}
            </div>
          ))}
        </>
      )}

      {/* Empty state */}
      {displayOptions.length === 0 && (
        <DropdownEmptyState>
          {debouncedSearchText
            ? i18n.t("No commands matching \"{{text}}\"", { text: debouncedSearchText })
            : "No commands available"}
        </DropdownEmptyState>
      )}
    </DropdownPanel>
  )
})