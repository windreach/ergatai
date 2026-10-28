"use client"

import { cn } from "../../../lib/utils"
import { trpc } from "../../../lib/trpc"
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  memo,
} from "react"
import { createPortal } from "react-dom"
import type { SlashCommandOption } from "./types"
import { filterBuiltinCommands } from "./builtin-commands"
import type { AgentMode } from "../atoms"
import { getDropdownDimensions } from "../ui/dropdown-sizes"
import { useDropdownScale } from "../../../lib/hooks/use-dropdown-scale"

interface AgentsSlashCommandProps {
  isOpen: boolean
  onClose: () => void
  onSelect: (command: SlashCommandOption) => void
  searchText: string
  position: { top: number; left: number }
  chatId?: string
  mode?: AgentMode
  disabledCommands?: string[]
}

// Memoized to prevent re-renders when parent re-renders
export const AgentsSlashCommand = memo(function AgentsSlashCommand({
  isOpen,
  onClose,
  onSelect,
  searchText,
  position,
  chatId,
  mode,
  disabledCommands,
}: AgentsSlashCommandProps) {
  const dropdownRef = useRef<HTMLDivElement>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const placementRef = useRef<"above" | "below" | null>(null)
  const [debouncedSearchText, setDebouncedSearchText] = useState(searchText)

  // Debounce search text (300ms to match file mention)
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearchText(searchText)
    }, 300)
    return () => clearTimeout(timer)
  }, [searchText])

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

  // Fetch available commands from the running agent via ergatai backend
  const { data: agentCommandsData } = trpc.ergatai.getAgentCommands.useQuery(
    { agentId: agentId ?? "" },
    {
      enabled: isOpen && !!agentId,
      staleTime: 30_000, // Cache for 30 seconds - commands rarely change mid-session
      refetchOnWindowFocus: false,
    },
  )

  // Transform backend commands to SlashCommandOption
  // The ergatai backend returns { commands: Array<{ name: string; description?: string }> }
  // but ergataiFetch doesn't have typed returns, so we use unknown and validate
  const agentCommands: SlashCommandOption[] = useMemo(() => {
    const data = agentCommandsData as { commands?: Array<{ name: string; description?: string }> } | undefined
    const raw = data?.commands
    if (!Array.isArray(raw)) return []
    return raw.map((cmd) => ({
      id: `agent:${cmd.name}`,
      name: cmd.name,
      command: `/${cmd.name}`,
      description: cmd.description || "",
      category: "agent" as const,
    }))
  }, [agentCommandsData])

  // Handle command selection
  const handleSelect = useCallback(
    (option: SlashCommandOption) => {
      onSelect(option)
    },
    [onSelect],
  )

  // Combine builtin + agent commands, filtered by search
  const options: SlashCommandOption[] = useMemo(() => {
    let builtinFiltered = filterBuiltinCommands(debouncedSearchText)

    // Hide /plan when already in Plan mode, hide /agent when already in Agent mode
    if (mode !== undefined) {
      builtinFiltered = builtinFiltered.filter((cmd) => {
        if (mode === "plan" && cmd.name === "plan") return false
        if (mode === "agent" && cmd.name === "agent") return false
        return true
      })
    }

    // Filter out disabled commands
    if (disabledCommands?.length) {
      builtinFiltered = builtinFiltered.filter(
        (cmd) => !disabledCommands.includes(cmd.name),
      )
    }

    // Filter agent commands by search
    let agentFiltered = agentCommands
    if (debouncedSearchText) {
      const query = debouncedSearchText.toLowerCase()
      agentFiltered = agentCommands.filter(
        (cmd) =>
          cmd.name.toLowerCase().includes(query) ||
          cmd.command.toLowerCase().includes(query),
      )
    }

    // Deduplicate: agent commands override builtin commands with same name
    const agentNames = new Set(agentFiltered.map((c) => c.name))
    const dedupedBuiltin = builtinFiltered.filter(
      (cmd) => !agentNames.has(cmd.name),
    )

    // Sort: agent commands first, then builtin, each group sorted by name length
    return [
      ...agentFiltered.sort(
        (a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name),
      ),
      ...dedupedBuiltin.sort(
        (a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name),
      ),
    ]
  }, [debouncedSearchText, agentCommands, mode, disabledCommands])

  // Track previous values for smarter selection reset
  const prevIsOpenRef = useRef(isOpen)
  const prevSearchRef = useRef(debouncedSearchText)

  // CONSOLIDATED: Single useLayoutEffect for selection management
  useLayoutEffect(() => {
    const didJustOpen = isOpen && !prevIsOpenRef.current
    const didSearchChange = debouncedSearchText !== prevSearchRef.current

    // Reset to 0 when opening or search changes
    if (didJustOpen || didSearchChange) {
      setSelectedIndex(0)
    }
    // Clamp to valid range if options shrunk
    else if (options.length > 0 && selectedIndex >= options.length) {
      setSelectedIndex(Math.max(0, options.length - 1))
    }

    // Update refs
    prevIsOpenRef.current = isOpen
    prevSearchRef.current = debouncedSearchText
  }, [isOpen, debouncedSearchText, options.length, selectedIndex])

  // Reset placement when closed
  useEffect(() => {
    if (!isOpen) {
      placementRef.current = null
    }
  }, [isOpen])

  // Keyboard navigation
  useEffect(() => {
    if (!isOpen) return

    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault()
          e.stopPropagation()
          e.stopImmediatePropagation()
          // Guard against modulo by zero when no options
          if (options.length > 0) {
            setSelectedIndex((prev) => (prev + 1) % options.length)
          }
          break
        case "ArrowUp":
          e.preventDefault()
          e.stopPropagation()
          e.stopImmediatePropagation()
          // Guard against modulo by zero when no options
          if (options.length > 0) {
            setSelectedIndex(
              (prev) => (prev - 1 + options.length) % options.length,
            )
          }
          break
        case "Enter":
          if (e.shiftKey) return
          e.preventDefault()
          e.stopPropagation()
          e.stopImmediatePropagation()
          if (options[selectedIndex]) {
            handleSelect(options[selectedIndex])
          }
          break
        case "Escape":
          e.preventDefault()
          e.stopPropagation()
          e.stopImmediatePropagation()
          onClose()
          break
        case "Tab":
          e.preventDefault()
          e.stopPropagation()
          e.stopImmediatePropagation()
          if (options[selectedIndex]) {
            handleSelect(options[selectedIndex])
          }
          break
      }
    }

    window.addEventListener("keydown", handleKeyDown, { capture: true })
    return () =>
      window.removeEventListener("keydown", handleKeyDown, { capture: true })
  }, [isOpen, options, selectedIndex, handleSelect, onClose])

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

  // Get dropdown dimensions with dynamic scaling based on window size
  const scale = useDropdownScale()

  if (!isOpen) return null

  const dimensions = getDropdownDimensions(scale)

  // Calculate dropdown dimensions (matching file mention style)
  const dropdownWidth = dimensions.width
  const itemHeight = dimensions.itemHeight
  const headerHeight = dimensions.headerHeight
  // Single "Commands" header for all options
  const headersCount = options.length > 0 ? 1 : 0
  const requestedHeight = Math.min(
    options.length * itemHeight + headersCount * headerHeight + dimensions.gap,
    dimensions.maxHeight,
  )
  const gap = dimensions.gap

  // Decide placement like Radix Popover (auto-flip top/bottom)
  const safeMargin = 10
  const caretOffsetBelow = 20
  const availableBelow =
    window.innerHeight - (position.top + caretOffsetBelow) - safeMargin
  const availableAbove = position.top - safeMargin

  // Compute desired placement, but lock it for the duration of the open state.
  // Ref is read during render (allowed); it is only written inside useLayoutEffect.
  const placement = useMemo(() => {
    if (placementRef.current !== null) return placementRef.current
    const condition1 =
      availableAbove >= requestedHeight && availableBelow < requestedHeight
    const condition2 =
      availableAbove > availableBelow && availableAbove >= requestedHeight
    const shouldPlaceAbove = condition1 || condition2
    return shouldPlaceAbove ? "above" : "below"
  }, [availableAbove, availableBelow, requestedHeight])

  useLayoutEffect(() => {
    placementRef.current = placement
  }, [placement])
  const placeAbove = placement === "above"

  // Compute final top based on placement
  let finalTop = placeAbove
    ? position.top - gap
    : position.top + gap + caretOffsetBelow

  // Slight left bias to better align with '/'
  const leftOffset = -4
  let finalLeft = position.left + leftOffset

  // Adjust horizontal overflow
  if (finalLeft + dropdownWidth > window.innerWidth - safeMargin) {
    finalLeft = window.innerWidth - dropdownWidth - safeMargin
  }
  if (finalLeft < safeMargin) {
    finalLeft = safeMargin
  }

  // Compute actual maxHeight based on available space on the chosen side
  const computedMaxHeight = Math.max(
    80,
    Math.min(
      requestedHeight,
      placeAbove ? availableAbove - gap : availableBelow - gap,
    ),
  )
  const transformY = placeAbove ? "translateY(-100%)" : "translateY(0)"

  return createPortal(
    <div
      ref={dropdownRef}
      className="fixed z-[99999] overflow-y-auto rounded-[10px] border border-border bg-popover py-1 text-xs text-popover-foreground shadow-lg dark [&::-webkit-scrollbar]:hidden"
      style={{
        top: finalTop,
        left: finalLeft,
        width: `${dropdownWidth}px`,
        maxHeight: `${computedMaxHeight}px`,
        transform: `${transformY} scale(${scale})`,
        transformOrigin: placeAbove ? 'bottom' : 'top',
        scrollbarWidth: 'none',
        msOverflowStyle: 'none',
      } as React.CSSProperties}
    >
      {/* All commands in one section - custom first, then builtin */}
      {options.length > 0 && (
        <>
          <div className="px-2.5 py-1.5 mx-1 text-xs font-medium text-muted-foreground">
            Commands
          </div>
          {options.map((option, index) => {
            const isSelected = selectedIndex === index
            return (
              <div
                key={option.id}
                data-option-index={index}
                onMouseDown={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  handleSelect(option)
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
        </>
      )}

      {/* Empty state */}
      {options.length === 0 && (
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
