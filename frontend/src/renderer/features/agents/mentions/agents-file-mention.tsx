import i18n from "@/lib/i18n"
"use client"

import { api } from "../../../lib/api-adapter"
import { trpc } from "../../../lib/trpc"
import { keepPreviousData } from "@tanstack/react-query"
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  memo,
} from "react"
import type { FileMentionOption } from "./agents-mentions-editor"
import { isImeComposing, MENTION_PREFIXES } from "./mentions-utils"
import type { CoreAgentOption } from "../lib/agent-contract-api"
import { useDiscoveryGroups } from "../discovery/use-discovery-groups"
import { useDropdownShell } from "../discovery/use-dropdown-shell"
import {
  DropdownEmptyState,
  DropdownOption,
  DropdownPanel,
  DropdownSectionHeader,
} from "../discovery/dropdown-ui"


interface ChangedFile {
  filePath: string
  displayPath: string
  additions: number
  deletions: number
}

interface AgentsFileMentionProps {
  isOpen: boolean
  onClose: () => void
  onSelect: (mention: FileMentionOption) => void
  searchText: string
  position: { top: number; left: number }
  containerWidth?: number
  containerLeft?: number
  teamId?: string
  repository?: string
  sandboxId?: string
  branch?: string // For fetching files from specific branch via GitHub API
  projectPath?: string // For fetching files from local project directory (desktop)
  projectPaths?: string[] // For fetching files from multiple local project directories (desktop)
  browseRoot?: string | null // Current directory root for @ browsing
  onBrowseRootChange?: (path: string | null) => void
  changedFiles?: ChangedFile[] // Files changed in current conversation (shown at top)
  agentId?: string // Agent ID for discovery endpoint (skills, commands, MCP)
  agentKind?: string
  // Subpage navigation state
  showingFilesList?: boolean
  showingAgentsList?: boolean
  scope?: "agents" | "resources" | "all"
  boundAgents?: CoreAgentOption[]
}

// Category navigation options (shown on root view)
const CATEGORY_OPTIONS: FileMentionOption[] = [
  { id: "files", label: "Files & Folders", type: "category", path: "", repository: "" },
  { id: "agents", label: "Agents", type: "category", path: "", repository: "" },
]

// Human-readable labels keyed by mention item kind.
// MCP tools and plugins are intentionally absent: the backend no longer
// surfaces them as composer mentions.
const MENTION_TYPE_LABELS: Record<string, string> = {
  file: "Files",
  folder: "Files",
  agent: "Agents",
  skill: "Skills",
  command: "Commands",
  category: "Mentions",
}

function getMentionTypeKey(option: FileMentionOption): string {
  return option.type === "folder" ? "file" : option.type ?? "file"
}

function getMentionGroupLabel(option: FileMentionOption): string {
  if (option.group) return option.group
  return MENTION_TYPE_LABELS[getMentionTypeKey(option)] ?? "Mentions"
}

/**
 * Insert section headers when the result set mixes item kinds (for example
 * files plus agents returned by discovery). Single-kind lists keep the flat
 * layout and rely on the dropdown title instead.
 */
function applyMentionGroupHeaders(items: FileMentionOption[]): FileMentionOption[] {
  if (items.some((item) => item.type === "group-header" || item.type === "category")) {
    return items
  }

  const typeKeys = new Set(items.map(getMentionTypeKey))
  if (typeKeys.size <= 1) return items

  const groups = new Map<string, FileMentionOption[]>()
  for (const item of items) {
    const label = getMentionGroupLabel(item)
    const bucket = groups.get(label)
    if (bucket) bucket.push(item)
    else groups.set(label, [item])
  }

  const flat: FileMentionOption[] = []
  for (const [label, groupItems] of groups) {
    flat.push({ id: `group:${label}`, label, path: "", repository: "", type: "group-header" })
    flat.push(...groupItems)
  }
  return flat
}

/**
 * Title for the dropdown section, derived from the visible items instead of
 * being hardcoded. A mixed result set falls back to the generic "Mentions".
 */
function getMentionSectionLabel(options: FileMentionOption[]): string {
  const items = options.filter(
    (option) => option.type !== "group-header" && option.type !== "category",
  )
  if (items.length === 0) return "Mentions"

  const typeKeys = new Set(items.map(getMentionTypeKey))
  if (typeKeys.size === 1) {
    return MENTION_TYPE_LABELS[[...typeKeys][0]] ?? "Mentions"
  }
  return "Mentions"
}

/**
 * Check if a string matches all search words (multi-word search)
 * Splits search by whitespace, all words must be present in target
 */
function matchesMultiWordSearch(target: string, searchLower: string): boolean {
  if (!searchLower) return true
  const searchWords = searchLower.split(/\s+/).filter(Boolean)
  if (searchWords.length === 0) return true
  const targetLower = target.toLowerCase()
  return searchWords.every(word => targetLower.includes(word))
}

/**
 * Sort files by relevance to search query
 * Priority: exact match > starts with > shorter match > contains in filename > alphabetical
 * Supports multi-word search - splits by whitespace, all words must match
 * When search ends with space, prioritize files with hyphen/underscore (e.g. "agents " -> "agents-sidebar")
 */
function sortFilesByRelevance<T extends { label: string; path?: string }>(
  files: T[],
  searchText: string,
): T[] {
  if (!searchText) return files

  const searchLower = searchText.toLowerCase()
  const searchWords = searchLower.split(/\s+/).filter(Boolean)
  const isSingleWord = searchWords.length <= 1
  // Check if search ends with space - user wants to continue with hyphenated names
  const endsWithSpace = searchText.endsWith(" ")

  return [...files].sort((a, b) => {
    const aLabelLower = a.label.toLowerCase()
    const bLabelLower = b.label.toLowerCase()

    // Get filename without extension for matching
    const aNameNoExt = aLabelLower.replace(/\.[^.]+$/, "")
    const bNameNoExt = bLabelLower.replace(/\.[^.]+$/, "")

    // For multi-word search, prioritize files where all words match in filename
    if (!isSingleWord) {
      const aAllInFilename = searchWords.every(w => aLabelLower.includes(w))
      const bAllInFilename = searchWords.every(w => bLabelLower.includes(w))
      if (aAllInFilename && !bAllInFilename) return -1
      if (!aAllInFilename && bAllInFilename) return 1
    }

    // When search ends with space, prioritize files with hyphen/underscore after first word
    // e.g. "agents " should show "agents-sidebar" before "agents" folder
    if (endsWithSpace && searchWords.length >= 1) {
      const lastWord = searchWords[searchWords.length - 1]
      // Check if filename has hyphen/underscore continuation after matching word
      const aHasContinuation = aNameNoExt.includes(`${lastWord}-`) || aNameNoExt.includes(`${lastWord}_`)
      const bHasContinuation = bNameNoExt.includes(`${lastWord}-`) || bNameNoExt.includes(`${lastWord}_`)
      if (aHasContinuation && !bHasContinuation) return -1
      if (!aHasContinuation && bHasContinuation) return 1
    }

    // Priority 1: EXACT match (chat.tsx when searching "chat") - single word only, not when ending with space
    if (isSingleWord && !endsWithSpace) {
      const aExact = aNameNoExt === searchLower
      const bExact = bNameNoExt === searchLower
      if (aExact && !bExact) return -1
      if (!aExact && bExact) return 1
    }

    // Priority 2: filename STARTS with first search word
    const firstWord = searchWords[0] || searchLower
    const aStartsWith = aNameNoExt.startsWith(firstWord)
    const bStartsWith = bNameNoExt.startsWith(firstWord)
    if (aStartsWith && !bStartsWith) return -1
    if (!aStartsWith && bStartsWith) return 1

    // Priority 3: If both start with query, shorter name = higher match %
    // But when ending with space, prefer longer (hyphenated) names
    if (aStartsWith && bStartsWith) {
      if (aNameNoExt.length !== bNameNoExt.length) {
        if (endsWithSpace) {
          return bNameNoExt.length - aNameNoExt.length // longer first when space at end
        }
        return aNameNoExt.length - bNameNoExt.length // shorter first normally
      }
    }

    // Priority 4: filename CONTAINS first word (but doesn't start with it)
    const aFilenameMatch = aLabelLower.includes(firstWord)
    const bFilenameMatch = bLabelLower.includes(firstWord)
    if (aFilenameMatch && !bFilenameMatch) return -1
    if (!aFilenameMatch && bFilenameMatch) return 1

    // Finally: alphabetically by label
    return a.label.localeCompare(b.label)
  })
}


// Memoized to prevent re-renders when parent re-renders
// react-doctor-disable-next-line no-high-complexity-react-function
// react-doctor-disable-next-line no-giant-component
export const AgentsFileMention = memo(function AgentsFileMention({
  isOpen,
  onClose,
  onSelect,
  searchText,
  position,
  containerWidth,
  containerLeft,
  teamId,
  repository,
  sandboxId,
  branch,
  projectPath,
  projectPaths,
  browseRoot,
  onBrowseRootChange,
  // react-doctor-disable-next-line rerender-memo-with-default-value
  changedFiles = [],
  agentId,
  agentKind,
  showingFilesList = false,
  showingAgentsList = false,
  scope = "all",
  boundAgents,
}: AgentsFileMentionProps) {
  // Track subpage changes to reset selection (file-mention specific)
  const prevShowingFilesListRef = useRef(showingFilesList)
  const prevShowingAgentsListRef = useRef(showingAgentsList)

  // Local debounce (300ms) — needed because memos depend on debouncedSearchText,
  // and useDropdownShell needs options.length (which depends on debouncedSearchText).
  const [debouncedSearchText, setDebouncedSearchText] = useState(searchText)
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearchText(searchText), 300)
    return () => clearTimeout(timer)
  }, [searchText])

  // Generic discovery aggregation (shared abstraction for trigger dropdowns).
  const { groups: discoveryGroups, isLoading: discoveryLoading } = useDiscoveryGroups(isOpen ? agentId : undefined, projectPath, agentKind)

  // `@` surfaces prompt-addressable convention agents (currently Codex).
  // Claude Code and OpenCode subagents are tool-driven, so discovery does not
  // expose them as @ candidates.
  const customAgents = useMemo(() => [] as any[], [])

  // For multi-word search, send only first word to API (server filters by that),
  // then filter results on client by all words
  const apiSearchQuery = useMemo(() => {
    if (!debouncedSearchText) return ""
    const words = debouncedSearchText.split(/\s+/).filter(Boolean)
    return words[0] || ""
  }, [debouncedSearchText])

  // Fetch files from API
  // Priority: sandboxId (includes uncommitted) > branch (GitHub API) > cached file_tree
  const {
    data: fileResults = [],
    error,
    isFetching: filesFetching,
  } = api.github.searchFiles.useQuery(
    {
      teamId: teamId!,
      repository: repository!,
      query: apiSearchQuery,
      limit: 50,
      sandboxId: sandboxId,
      branch: branch, // Pass branch for GitHub API fetch
      projectPath: projectPath, // For local project file search (desktop)
      projectPaths: projectPaths, // For local project file search (desktop, multi-root)
      collapseChains: !debouncedSearchText,
      collapseRoot: browseRoot || undefined,
    },
    {
      // Enable if we have projectPath/projectPaths (desktop) OR teamId with repository/sandboxId/branch (web)
      // Also enable when showingFilesList is true (user explicitly selected files category)
      enabled: isOpen && ((!!projectPath || (projectPaths && projectPaths.length > 0)) || (!!teamId && (!!repository || !!sandboxId || !!branch))),
      staleTime: 5000,
      refetchOnWindowFocus: false,
      // Keep showing previous results while fetching new ones
      placeholderData: keepPreviousData,
    },
  )

  // Convert changed files to options (shown at top in separate group)
  const changedFileOptions: FileMentionOption[] = useMemo(() => {
    if (!changedFiles.length) return []

    const searchLower = debouncedSearchText.toLowerCase()

    const mapped = changedFiles
      .filter((file) =>
        // Multi-word search: all words must match in file path
        matchesMultiWordSearch(file.filePath, searchLower),
      )
      .map((file) => {
        // Use displayPath (relative path) for UI display, filePath only for internal ID
        const displayPath = file.displayPath || file.filePath
        const pathParts = displayPath.split("/")
        const fileName = pathParts.pop() || displayPath
        const dirPath = pathParts.join("/") || "/"

        return {
          id: `changed:${file.filePath}`,
          label: fileName,
          path: displayPath,
          repository: repository || "",
          truncatedPath: dirPath,
          type: "file" as const,
          additions: file.additions,
          deletions: file.deletions,
          group: "Changed Files",
        }
      })

    // Sort by relevance using shared function
    return sortFilesByRelevance(mapped, debouncedSearchText)
  }, [changedFiles, debouncedSearchText, repository])

  // Convert API results to options with truncated path
  // Exclude files that are already in changedFileOptions
  const changedFilePaths = useMemo(
    () => new Set(changedFiles.map((f) => f.filePath)),
    [changedFiles],
  )

  const repoFileOptions: FileMentionOption[] = useMemo(() => {
    const searchLower = debouncedSearchText.toLowerCase()

    const mapped = fileResults
      .filter((file) => !changedFilePaths.has(file.path))
      // Client-side multi-word filtering (API only filtered by first word)
      .filter((file) => matchesMultiWordSearch(file.path, searchLower))
      .map((file) => {
        // Get directory path (without filename/foldername) for inline display
        const pathParts = file.path.split("/")
        const dirPath = pathParts.slice(0, -1).join("/") || "/"

        return {
          id: file.id,
          label: file.label,
          path: file.path,
          repository: file.repository,
          truncatedPath: dirPath,
          type: (file as { type?: "file" | "folder" }).type ?? "file",
          group: "Files",
        }
      })

    // Sort by relevance using shared function
    return sortFilesByRelevance(mapped, debouncedSearchText)
  }, [fileResults, changedFilePaths, debouncedSearchText])

  // Generic discovery -> mention options (shared abstraction).
  const discoveryMentionOptions: FileMentionOption[] = useMemo(() => {
    const searchLower = debouncedSearchText.toLowerCase()
    const out: FileMentionOption[] = []
    for (const g of discoveryGroups) {
      for (const it of g.items) {
        // Only skills route to @ mentions. MCP tools are model-invoked and
        // plugins are agent-native, so neither is surfaced in the composer.
        if (it.type !== "skill") continue
        // Routing is authoritative via backend-stamped targetTriggers.
        if (!it.targetTriggers?.includes("@")) continue
        const mentionType = "skill"
        const prefix = MENTION_PREFIXES.SKILL
        if (!matchesMultiWordSearch(it.name, searchLower) && !matchesMultiWordSearch(it.description || "", searchLower)) continue
        out.push({
          id: `${prefix}${it.name}`,
          label: it.name,
          path: it.name,
          repository: "",
          type: mentionType,
          group: g.id,
          description: it.description || "",
        })
      }
    }
    return out
  }, [discoveryGroups, debouncedSearchText])

  // Agents can also arrive through backend discovery, not only through the
  // profile list, so surface them under the same "Agents" group.
  const discoveryAgentOptions: FileMentionOption[] = useMemo(() => {
    const searchLower = debouncedSearchText.toLowerCase()
    const out: FileMentionOption[] = []
    for (const g of discoveryGroups) {
      for (const it of g.items) {
        if (it.type !== "agent") continue
        // Respect explicit routing markers, but don't drop agents that the
        // backend returned without trigger metadata.
        if (it.targetTriggers && !it.targetTriggers.includes("@")) continue
        if (
          !matchesMultiWordSearch(it.name, searchLower) &&
          !matchesMultiWordSearch(it.description || "", searchLower)
        ) continue
        out.push({
          id: `${MENTION_PREFIXES.AGENT}${it.name}`,
          label: it.name,
          path: it.name,
          repository: "",
          type: "agent",
          group: g.label || "Agents",
          description: it.description || "",
        })
      }
    }
    return out
  }, [discoveryGroups, debouncedSearchText])

  // Convert custom agents to mention options
  const agentOptions: FileMentionOption[] = useMemo(() => {
    const searchLower = debouncedSearchText.toLowerCase()

    if (scope === "agents" && boundAgents) {
      return boundAgents
        .filter(agent => matchesMultiWordSearch(agent.name, searchLower))
        .map(agent => ({
          id: `${MENTION_PREFIXES.AGENT}${agent.name}`,
          label: agent.name,
          path: agent.name,
          repository: "",
          type: "agent" as const,
          group: "Agents",
        }))
    }

    return customAgents
      .filter(agent =>
        // Multi-word search: all words must match in name OR description
        matchesMultiWordSearch(agent.name, searchLower) ||
        matchesMultiWordSearch(agent.description, searchLower)
      )
      .map(agent => ({
        id: `${MENTION_PREFIXES.AGENT}${agent.name}`,
        label: agent.name,
        path: agent.path, // file path for tooltip
        repository: "",
        truncatedPath: agent.description,
        type: "agent" as const,
        group: "Agents",
        // Extended data for rich tooltip
        description: agent.description,
        tools: agent.tools,
        model: agent.model,
        source: agent.source,
      }))
  }, [customAgents, debouncedSearchText, scope, boundAgents])

  // Merge profile agents with discovery agents, keeping profile metadata when
  // both sources report the same agent. Group mode is restricted to the agents
  // bound to the group, so don't append discovery agents there.
  const allAgentOptions: FileMentionOption[] = useMemo(() => {
    const sources =
      scope === "agents" && boundAgents
        ? agentOptions
        : [...agentOptions, ...discoveryAgentOptions]
    const byName = new Map<string, FileMentionOption>()
    for (const option of sources) {
      if (!byName.has(option.label)) byName.set(option.label, option)
    }
    return [...byName.values()]
  }, [agentOptions, discoveryAgentOptions, scope, boundAgents])

  // Keep only files and agents
  const hasSkills = discoveryMentionOptions.some((o) => o.type === "skill")
  const hasDiscoveryAgents = discoveryGroups.some((g) =>
    g.items.some((it) => it.type === "agent" && (!it.targetTriggers || it.targetTriggers.includes("@"))),
  )
  const hasAgents = customAgents.length > 0 || hasDiscoveryAgents
  const hasOnlyFiles = discoveryMentionOptions.length === 0 && !hasAgents

  // Filter category options based on available data
  const availableCategoryOptions = useMemo(() => {
    return CATEGORY_OPTIONS.filter(category => {
      if (scope === "agents") return category.id === "files"
      if (scope === "resources" && category.id === "agents") return false
      if (category.id === "files") return true // Always show files
      if (category.id === "skills") return hasSkills
      if (category.id === "agents") return hasAgents
      return true
    })
  }, [scope, hasSkills, hasAgents])

  // Combined options for keyboard navigation
  const options: FileMentionOption[] = useMemo(() => {
    // agents scope: show files directly, plus any agents the backend reports.
    if (scope === "agents") {
      const allItems = [...allAgentOptions, ...changedFileOptions, ...repoFileOptions]
      if (debouncedSearchText) {
        return applyMentionGroupHeaders(
          sortFilesByRelevance(allItems, debouncedSearchText),
        )
      }
      return applyMentionGroupHeaders(allItems)
    }
    // agents scope now falls through so files can be shown; skills/tools excluded below

    // SUBPAGE: Files (or if no skills/agents, show files directly)
    if (showingFilesList || hasOnlyFiles) {
      const allFiles = [...changedFileOptions, ...repoFileOptions]
      if (debouncedSearchText) {
        return sortFilesByRelevance(allFiles, debouncedSearchText)
      }
      return allFiles
    }

    // SUBPAGE: Agents
    if (showingAgentsList) {
      return allAgentOptions // already filtered by search in agentOptions memo
    }

    // ROOT VIEW
    if (debouncedSearchText) {
      // Global search: search across changed files + categories + skills + agents + repo files
      const searchLower = debouncedSearchText.toLowerCase()
      const filteredCategories = availableCategoryOptions.filter(c =>
        c.label.toLowerCase().includes(searchLower)
      )
      const allowedCategoryIds = new Set(["agents", "files", "skills"])
      const allItems = [
        ...changedFileOptions,
        ...filteredCategories.filter(c => allowedCategoryIds.has(c.id)),
        ...(scope === "all" ? allAgentOptions : []),
        ...discoveryMentionOptions,
        ...repoFileOptions,
      ]
      return applyMentionGroupHeaders(
        sortFilesByRelevance(allItems, debouncedSearchText),
      )
    }

    // No search: Flat grouped list with category headers (no drill-down).
    const groups = new Map<string, FileMentionOption[]>()
    const groupOrder: string[] = []
    const addToGroup = (item: FileMentionOption) => {
      const key = item.group || item.type || "other"
      if (!groups.has(key)) {
        groups.set(key, [])
        groupOrder.push(key)
      }
      groups.get(key)!.push(item)
    }
    if (scope !== "resources") {
      allAgentOptions.forEach(addToGroup)
    }
    discoveryMentionOptions.forEach(addToGroup)
    changedFileOptions.forEach(addToGroup)
    const flat: FileMentionOption[] = []
    for (const key of groupOrder) {
      const items = groups.get(key) || []
      if (items.length === 0) continue
      const label = MENTION_TYPE_LABELS[key] || key
      flat.push({ id: `group:${key}`, label, path: "", repository: "", type: "group-header" })
      flat.push(...items)
    }
    // Files & folders stay as a drill-down category (can be huge)
    const fileCategory = availableCategoryOptions.find(c => c.id === "files")
    if (fileCategory && repoFileOptions.length === 0 && changedFileOptions.length === 0) {
      flat.push(fileCategory)
    } else if (repoFileOptions.length > 0 && !debouncedSearchText) {
      flat.push({ id: "category:files", label: "Files & Folders", path: "", repository: "", type: "category" })
    }
    if (flat.length === 0) {
      return availableCategoryOptions
    }
    return flat
  }, [scope, showingFilesList, showingAgentsList, debouncedSearchText, changedFileOptions, repoFileOptions, allAgentOptions, hasOnlyFiles, availableCategoryOptions, discoveryMentionOptions])

  // Derive the dropdown title from the visible items so file-only lists show
  // "Files" and agent lists show "Agents" instead of a generic "Mentions".
  // Group headers already act as section titles, so don't repeat them on top.
  const sectionLabel = getMentionSectionLabel(options)
  const groupHeaderOptions = options.filter((option) => option.type === "group-header")
  const showSectionLabel = groupHeaderOptions.length === 0

  // Shared dropdown shell (keyboard nav, placement, auto-scroll, click outside)
  // Note: we use local debounce (above) for memos, and pass debounceMs: 0 to skip
  // the shell's internal debounce (avoiding double debounce delay).
  // Memoize isSelectable to avoid re-running keyboard effect on every render.
  const isSelectable = useCallback(
    (index: number) => options[index]?.type !== "group-header",
    [options],
  )
  const {
    dropdownRef,
    selectedIndex,
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
    searchText: debouncedSearchText, // Already debounced locally
    debounceMs: 0, // Skip internal debounce
    isSelectable,
  })

  // Reset selection when subpage changes (file-mention specific)
  useEffect(() => {
    const didSubpageChange =
      showingFilesList !== prevShowingFilesListRef.current ||
      showingAgentsList !== prevShowingAgentsListRef.current

    if (didSubpageChange) {
      setSelectedIndex(0)
    }

    prevShowingFilesListRef.current = showingFilesList
    prevShowingAgentsListRef.current = showingAgentsList
  }, [showingFilesList, showingAgentsList, setSelectedIndex])

  // Enter/Tab selection (shell handles Escape/Arrow)
  useEffect(() => {
    if (!isOpen) return

    const handleSelectKey = (e: KeyboardEvent) => {
      if (isImeComposing(e)) return
      switch (e.key) {
        case "Enter":
          if (e.shiftKey) return
          // fall through to shared selection logic
          break
        case "Tab":
          break
        default:
          return
      }
      e.preventDefault()
      e.stopPropagation()
      e.stopImmediatePropagation()
      if (options[selectedIndex] && options[selectedIndex].type !== "group-header") {
        onSelect(options[selectedIndex])
      }
    }

    window.addEventListener("keydown", handleSelectKey, { capture: true })
    return () =>
      window.removeEventListener("keydown", handleSelectKey, { capture: true })
  }, [isOpen, options, selectedIndex, onSelect])

  // Do not keep an empty dropdown open when there is no search text and no available items.
  useEffect(() => {
    if (!isOpen) return
    if (debouncedSearchText) return
    if (discoveryLoading || filesFetching) return
    if (options.length === 0) {
      onClose()
    }
  }, [isOpen, debouncedSearchText, discoveryLoading, filesFetching, options.length, onClose])

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
      {/* Browse root indicator */}
      {browseRoot && (
        <div className="flex items-center gap-2 px-2.5 py-1.5 mx-1 text-xs text-muted-foreground border-b border-border/50">
          <button
            type="button"
            aria-label={i18n.t('Clear browse root')}
            className="hover:text-foreground"
            onClick={() => onBrowseRootChange?.(null)}
          >
            ✕
          </button>
          <span className="truncate">{browseRoot}/</span>
        </div>
      )}

      {/* All mentions in one section */}
      {options.length > 0 && (
        <>
          {showSectionLabel && (
            <DropdownSectionHeader>{sectionLabel}</DropdownSectionHeader>
          )}
          {error && (
            <DropdownEmptyState className="text-red-500">
              Failed to load files
            </DropdownEmptyState>
          )}
          {options.map((option, index) => {
            const isSelected = selectedIndex === index
            const isGroupHeader = option.type === "group-header"
            if (isGroupHeader) {
              return (
                <DropdownSectionHeader key={option.id} optionIndex={index}>
                  {option.label}
                </DropdownSectionHeader>
              )
            }
            return (
              <DropdownOption
                key={option.id}
                optionIndex={index}
                selected={isSelected}
                onSelect={() => onSelect(option)}
                onMouseEnter={() => setSelectedIndex(index)}
                style={{ contentVisibility: "auto", containIntrinsicSize: "0 28px" }}
              >
                {option.type === "file" || option.type === "folder" ? (
                  /* Files and folders render the full path as a single line
                     instead of "name + path". */
                  <span
                    className="flex-1 min-w-0 overflow-hidden truncate"
                    title={option.path}
                  >
                    {option.path || option.label}
                  </span>
                ) : (
                  <>
                    <span className="shrink-0 whitespace-nowrap font-medium">
                      {option.label}
                    </span>
                    {option.description && (
                      <span
                        className="text-muted-foreground flex-1 min-w-0 ml-2 overflow-hidden text-[10px] truncate"
                      >
                        {option.description}
                      </span>
                    )}
                  </>
                )}
                {/* Diff stats for changed files */}
                {(option.additions || option.deletions) && (
                  <span className="shrink-0 flex items-center gap-1 text-[10px] font-mono ml-2">
                    {option.additions ? (
                      <span className="text-green-500">
                        +{option.additions}
                      </span>
                    ) : null}
                    {option.deletions ? (
                      <span className="text-red-500">
                        -{option.deletions}
                      </span>
                    ) : null}
                  </span>
                )}
              </DropdownOption>
            )
          })}
        </>
      )}

      {/* Empty state */}
      {options.length === 0 && (
        <DropdownEmptyState>
          {error
            ? i18n.t("Error loading files: {{message}}", { message: error.message })
            : debouncedSearchText
            ? i18n.t("No items matching \"{{text}}\"", { text: debouncedSearchText })
            : "No items available"}
        </DropdownEmptyState>
      )}
    </DropdownPanel>
  )
})