"use client"

import { cn } from "../../../lib/utils"
import { api } from "../../../lib/api-adapter"
import { trpc } from "../../../lib/trpc"
import { keepPreviousData } from "@tanstack/react-query"
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  createElement,
  memo,
} from "react"
import { flushSync, createPortal } from "react-dom"
import { createRoot } from "react-dom/client"
import { useAtomValue } from "jotai"
import type { FileMentionOption } from "./agents-mentions-editor"
import { MENTION_PREFIXES } from "./agents-mentions-editor"
import { sessionInfoAtom } from "../../../lib/atoms"
import type { CoreAgentOption } from "../lib/agent-contract-api"
import {
  FilesIcon,
  SkillIcon,
  CustomAgentIcon,
  OriginalMCPIcon,
} from "../../../components/ui/icons"
import { getDropdownDimensions } from "../ui/dropdown-sizes"
import { useDropdownScale } from "../../../lib/hooks/use-dropdown-scale"
import { FolderClosedIcon, getFileIconByExtension, createFileIconElement, getOptionIcon } from "./file-icon-utils"

// Custom folder icon matching design (open folder)
function FolderOpenIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      className={className}
    >
      <path
        d="M4 8V6C4 4.89543 4.89543 4 6 4H14C15.1046 4 16 4.89543 16 6M4 8H8.17548C8.70591 8 9.21462 8.21071 9.58969 8.58579L11.4181 10.4142C11.7932 10.7893 12.3019 11 12.8323 11H16M4 8C3.44987 8 3.00391 8.44597 3.00391 8.99609V18C3.00391 19.1046 3.89934 20 5.00391 20H19.0039C20.1085 20 21.0039 19.1046 21.0039 18V12.0039C21.0039 11.4495 20.5544 11 20 11M16 11V6M16 11H20M16 6H18C19.1046 6 20 6.89543 20 8V11"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
    </svg>
  )
}

import {
  TypeScriptIcon,
  JavaScriptIcon,
  PythonIcon,
  GoIcon,
  RustIcon,
  CodeIcon,
  ReactIcon,
  MarkdownInfoIcon,
  MarkdownIcon,
  CSSIcon,
  HTMLIcon,
  SCSSIcon,
  JSONIcon,
  YAMLIcon,
  ShellIcon,
  SQLIcon,
  GraphQLIcon,
  PrismaIcon,
  DockerIcon,
  TOMLIcon,
  JavaIcon,
  CIcon,
  CppIcon,
  CSharpIcon,
  PHPIcon,
  RubyIcon,
  KotlinIcon,
  VueIcon,
  SvelteIcon,
  AstroIcon,
  SwiftIcon,
  PDFIcon,
  SVGIcon,
  TxtIcon,
  GitIcon,
  NpmIcon,
  UnknownFileIcon,
} from "../../../icons/framework-icons"

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
  teamId?: string
  repository?: string
  sandboxId?: string
  branch?: string // For fetching files from specific branch via GitHub API
  projectPath?: string // For fetching files from local project directory (desktop)
  changedFiles?: ChangedFile[] // Files changed in current conversation (shown at top)
  // Subpage navigation state
  showingFilesList?: boolean
  showingSkillsList?: boolean
  showingAgentsList?: boolean
  showingToolsList?: boolean
  scope?: "agents" | "resources" | "all"
  boundAgents?: CoreAgentOption[]
}

// Category navigation options (shown on root view)
const CATEGORY_OPTIONS: FileMentionOption[] = [
  { id: "files", label: "Files & Folders", type: "category", path: "", repository: "" },
  { id: "skills", label: "Skills", type: "category", path: "", repository: "" },
  { id: "agents", label: "Agents", type: "category", path: "", repository: "" },
  { id: "tools", label: "MCP", type: "category", path: "", repository: "" },
]

// Known file extensions with icons
const KNOWN_FILE_ICON_EXTENSIONS = new Set([
  "tsx",
  "ts",
  "js",
  "mjs",
  "cjs",
  "jsx",
  "py",
  "pyw",
  "pyi",
  "go",
  "rs",
  "md",
  "mdx",
  "css",
  "html",
  "htm",
  "scss",
  "sass",
  "json",
  "jsonc",
  "yaml",
  "yml",
  "sh",
  "bash",
  "zsh",
  "sql",
  "graphql",
  "gql",
  "prisma",
  "dockerfile",
  "toml",
  "env",
  "java",
  "c",
  "h",
  "cpp",
  "cc",
  "cxx",
  "hpp",
  "cs",
  "php",
  "rb",
  "kt",
  "vue",
  "svelte",
  "astro",
  "swift",
  "pdf",
  "svg",
  "txt",
])


// Tool icon component (MCP icon) - slightly larger for visibility



// Folder icon component for consistency with file icons

// Skill icon component (local wrapper for getOptionIcon)


// ToolIconWrapper removed - use ToolIcon instead (they were identical)

// Category icon component

/**
 * Get icon component for a file, folder, skill, agent, tool, or category option
 */

/**
 * Render folder path as a tree structure for tooltip
 * e.g., "apps/web/app" becomes:
 *   📁 apps
 *     📁 web
 *       📁 app
 */
function renderFolderTree(path: string) {
  const parts = path.split("/").filter(Boolean)
  const lastIndex = parts.length - 1
  return (
    <div className="flex flex-col gap-1 min-w-[220px]">
      {parts.map((part, index) => {
        const isLast = index === lastIndex
        return (
          <div
            key={index}
            className={cn(
              "flex items-center gap-1.5 text-xs",
              isLast ? "text-foreground" : "text-muted-foreground"
            )}
            style={{ paddingLeft: `${index * 20}px` }}
          >
            <FolderOpenIcon className={cn(
              "h-3.5 w-3.5 flex-shrink-0",
              isLast ? "text-foreground/70" : "text-muted-foreground"
            )} />
            <span className={isLast ? "font-medium" : ""}>{part}</span>
          </div>
        )
      })}
    </div>
  )
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

/**
 * Render tooltip content for a mention option
 * Skills/agents show description, tools, model info
 * Tools show MCP server name
 * Files/folders show path
 */
function renderTooltipContent(option: FileMentionOption) {
  if (option.type === "folder") {
    return renderFolderTree(option.path)
  }

  if (option.type === "skill" || option.type === "agent") {
    return (
      <div className="flex flex-col gap-1.5 w-full overflow-hidden">
        {option.description && (
          <p className="text-xs text-muted-foreground break-words">
            {option.description}
          </p>
        )}
        {option.model && (
          <div className="text-xs text-muted-foreground">
            Model: {option.model}
          </div>
        )}
        {option.tools && option.tools.length > 0 && (
          <div className="text-xs text-muted-foreground break-words">
            Tools: {option.tools.join(", ")}
          </div>
        )}
        <div className="text-[10px] text-muted-foreground/70 font-mono truncate w-full">
          {option.path}
        </div>
      </div>
    )
  }

  if (option.type === "tool") {
    return null
  }

  // Files - just path
  return (
    <div className="text-xs text-muted-foreground font-mono truncate w-full">
      {option.path}
    </div>
  )
}

// Memoized to prevent re-renders when parent re-renders
export const AgentsFileMention = memo(function AgentsFileMention({
  isOpen,
  onClose,
  onSelect,
  searchText,
  position,
  teamId,
  repository,
  sandboxId,
  branch,
  projectPath,
  changedFiles = [],
  showingFilesList = false,
  showingSkillsList = false,
  showingAgentsList = false,
  showingToolsList = false,
  scope = "all",
  boundAgents,
}: AgentsFileMentionProps) {
  const dropdownRef = useRef<HTMLDivElement>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const placementRef = useRef<"above" | "below" | null>(null)
  const [debouncedSearchText, setDebouncedSearchText] = useState(searchText)

  // Get session info (MCP servers, tools) from atom
  const sessionInfo = useAtomValue(sessionInfoAtom)

  // Fetch skills from filesystem (cached for 5 minutes)
  const { data: skills = [], isFetching: isFetchingSkills } = trpc.skills.listEnabled.useQuery(
    projectPath ? { cwd: projectPath } : undefined,
    {
      enabled: isOpen && scope !== "agents",
      staleTime: 5 * 60 * 1000, // 5 minutes - skills don't change frequently
    },
  )

  // Fetch custom agents from filesystem (cached for 5 minutes)
  const { data: customAgents = [], isFetching: isFetchingAgents } = trpc.agents.listEnabled.useQuery(
    projectPath ? { cwd: projectPath } : undefined,
    {
      enabled: isOpen,
      staleTime: 5 * 60 * 1000, // 5 minutes - agents don't change frequently
    },
  )

  // Debounce search text (300ms to match canvas implementation)
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearchText(searchText)
    }, 300)
    return () => clearTimeout(timer)
  }, [searchText])

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
    isLoading,
    isFetching,
    error,
  } = api.github.searchFiles.useQuery(
    {
      teamId: teamId!,
      repository: repository!,
      query: apiSearchQuery,
      limit: 50,
      sandboxId: sandboxId,
      branch: branch, // Pass branch for GitHub API fetch
      projectPath: projectPath, // For local project file search (desktop)
    },
    {
      // Enable if we have projectPath (desktop) OR teamId with repository/sandboxId/branch (web)
      enabled: isOpen && scope !== "agents" && (!!projectPath || (!!teamId && (!!repository || !!sandboxId || !!branch))),
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
          additions: file.additions,
          deletions: file.deletions,
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
          type: (file as { type?: "file" | "folder" }).type,
        }
      })

    // Sort by relevance using shared function
    return sortFilesByRelevance(mapped, debouncedSearchText)
  }, [fileResults, changedFilePaths, debouncedSearchText])

  // Convert skills to mention options
  const skillOptions: FileMentionOption[] = useMemo(() => {
    const searchLower = debouncedSearchText.toLowerCase()

    return skills
      .filter(skill =>
        // Multi-word search: all words must match in name OR description
        matchesMultiWordSearch(skill.name, searchLower) ||
        matchesMultiWordSearch(skill.description, searchLower)
      )
      .map(skill => ({
        id: `${MENTION_PREFIXES.SKILL}${skill.name}`,
        label: skill.name,
        path: skill.path, // file path for tooltip
        repository: "",
        truncatedPath: skill.description,
        type: "skill" as const,
        // Extended data for rich tooltip
        description: skill.description,
        source: skill.source,
      }))
  }, [skills, debouncedSearchText])

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
        // Extended data for rich tooltip
        description: agent.description,
        tools: agent.tools,
        model: agent.model,
        source: agent.source,
      }))
  }, [customAgents, debouncedSearchText])

  // Convert MCP servers to mention options (show servers, not individual tools)
  const allToolOptions: FileMentionOption[] = useMemo(() => {
    if (!sessionInfo?.mcpServers) return []

    const connectedServers = sessionInfo.mcpServers
      .filter(s => s.status === "connected")

    return connectedServers.map(server => ({
      id: `${MENTION_PREFIXES.TOOL}${server.name}`,
      label: server.name,
      path: server.name,
      repository: "",
      truncatedPath: "",
      type: "tool" as const,
      mcpServer: server.name,
    }))
  }, [sessionInfo])

  // Filtered tool options based on search (searches by server name)
  const toolOptions: FileMentionOption[] = useMemo(() => {
    if (!debouncedSearchText) return allToolOptions

    const searchLower = debouncedSearchText.toLowerCase()
    return allToolOptions.filter(tool => {
      return matchesMultiWordSearch(tool.label, searchLower)
    })
  }, [allToolOptions, debouncedSearchText])

  // Check if we have skills, agents, or tools
  // Use base data (not search-filtered) for stable category display
  const hasSkills = skills.length > 0
  const hasAgents = customAgents.length > 0
  const hasTools = allToolOptions.length > 0
  const hasOnlyFiles = !hasSkills && !hasAgents && !hasTools

  // Determine if we're in a subpage view (or showing files directly when no skills/agents/tools)
  const isInSubpage = showingFilesList || showingSkillsList || showingAgentsList || showingToolsList || hasOnlyFiles

  // Filter category options based on available data
  const availableCategoryOptions = useMemo(() => {
    return CATEGORY_OPTIONS.filter(category => {
      if (scope === "agents") return category.id === "agents"
      if (scope === "resources" && category.id === "agents") return false
      if (category.id === "files") return true // Always show files
      if (category.id === "skills") return hasSkills
      if (category.id === "agents") return hasAgents
      if (category.id === "tools") return hasTools
      return true
    })
  }, [scope, hasSkills, hasAgents, hasTools])

  // Combined options for keyboard navigation
  // Subpage views show only that category's items
  // Root view shows changed files + category navigation options
  // Search filters globally in root view, within category in subpage
  // If no skills, agents, or tools, skip root view and show files directly
  const options: FileMentionOption[] = useMemo(() => {
    if (scope === "agents") {
      return agentOptions
    }

    // SUBPAGE: Files (or if no skills/agents/tools, show files directly)
    if (showingFilesList || hasOnlyFiles) {
      const allFiles = [...changedFileOptions, ...repoFileOptions]
      if (debouncedSearchText) {
        return sortFilesByRelevance(allFiles, debouncedSearchText)
      }
      return allFiles
    }

    // SUBPAGE: Skills
    if (showingSkillsList) {
      return skillOptions // already filtered by search in skillOptions memo
    }

    // SUBPAGE: Agents
    if (showingAgentsList) {
      return agentOptions // already filtered by search in agentOptions memo
    }

    // SUBPAGE: MCP Tools
    if (showingToolsList) {
      return toolOptions // already filtered by search in toolOptions memo
    }

    // ROOT VIEW
    if (debouncedSearchText) {
      // Global search: search across changed files + categories + skills + agents + tools + repo files
      const searchLower = debouncedSearchText.toLowerCase()
      const filteredCategories = availableCategoryOptions.filter(c =>
        c.label.toLowerCase().includes(searchLower)
      )
      const allItems = [
        ...changedFileOptions,
        ...filteredCategories,
        ...(scope === "all" ? agentOptions : []),
        ...skillOptions,
        ...toolOptions,
        ...repoFileOptions,
      ]
      return sortFilesByRelevance(allItems, debouncedSearchText)
    }

    // No search: Changed files FIRST (quick access), then category navigation
    return [...changedFileOptions, ...availableCategoryOptions]
  }, [scope, showingFilesList, showingSkillsList, showingAgentsList, showingToolsList, debouncedSearchText, changedFileOptions, repoFileOptions, skillOptions, agentOptions, toolOptions, hasOnlyFiles, availableCategoryOptions])

  // Track previous values for smarter selection reset
  const prevIsOpenRef = useRef(isOpen)
  const prevSearchRef = useRef(debouncedSearchText)
  const prevShowingFilesListRef = useRef(showingFilesList)
  const prevShowingSkillsListRef = useRef(showingSkillsList)
  const prevShowingAgentsListRef = useRef(showingAgentsList)
  const prevShowingToolsListRef = useRef(showingToolsList)

  // CONSOLIDATED: Single useLayoutEffect for selection management (was 3 separate)
  useLayoutEffect(() => {
    const didJustOpen = isOpen && !prevIsOpenRef.current
    const didSearchChange = debouncedSearchText !== prevSearchRef.current
    const didSubpageChange =
      showingFilesList !== prevShowingFilesListRef.current ||
      showingSkillsList !== prevShowingSkillsListRef.current ||
      showingAgentsList !== prevShowingAgentsListRef.current ||
      showingToolsList !== prevShowingToolsListRef.current

    // Reset to 0 when opening, search changes, or subpage changes
    if (didJustOpen || didSearchChange || didSubpageChange) {
      setSelectedIndex(0)
    }
    // Clamp to valid range if options shrunk
    else if (options.length > 0 && selectedIndex >= options.length) {
      setSelectedIndex(Math.max(0, options.length - 1))
    }

    // Update refs
    prevIsOpenRef.current = isOpen
    prevSearchRef.current = debouncedSearchText
    prevShowingFilesListRef.current = showingFilesList
    prevShowingSkillsListRef.current = showingSkillsList
    prevShowingAgentsListRef.current = showingAgentsList
    prevShowingToolsListRef.current = showingToolsList
  }, [isOpen, debouncedSearchText, options.length, selectedIndex, showingFilesList, showingSkillsList, showingAgentsList, showingToolsList])

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
          setSelectedIndex((prev) => (prev + 1) % options.length)
          break
        case "ArrowUp":
          e.preventDefault()
          e.stopPropagation()
          e.stopImmediatePropagation()
          setSelectedIndex(
            (prev) => (prev - 1 + options.length) % options.length,
          )
          break
        case "Enter":
          if (e.shiftKey) return
          e.preventDefault()
          e.stopPropagation()
          e.stopImmediatePropagation()
          if (options[selectedIndex]) {
            onSelect(options[selectedIndex])
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
  }, [isOpen, options, selectedIndex, onSelect, onClose])

  // Auto-scroll selected item into view
  useEffect(() => {
    if (!isOpen || !dropdownRef.current) return

    // Account for header element
    const headerOffset = 1
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

  // Calculate dropdown dimensions (matching / command style)
  const dropdownWidth = dimensions.width
  const itemHeight = dimensions.itemHeight
  const headerHeight = dimensions.headerHeight
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

  // Compute desired placement, but lock it for the duration of the open state
  if (placementRef.current === null) {
    const condition1 =
      availableAbove >= requestedHeight && availableBelow < requestedHeight
    const condition2 =
      availableAbove > availableBelow && availableAbove >= requestedHeight
    const shouldPlaceAbove = condition1 || condition2
    placementRef.current = shouldPlaceAbove ? "above" : "below"
  }
  const placeAbove = placementRef.current === "above"

  // Compute final top based on placement
  let finalTop = placeAbove
    ? position.top - gap
    : position.top + gap + caretOffsetBelow

  // Slight left bias to better align with '@'
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
      {/* All mentions in one section */}
      {options.length > 0 && (
        <>
          <div className="px-2.5 py-1.5 mx-1 text-xs font-medium text-muted-foreground">
            Mentions
          </div>
          {options.map((option, index) => {
            const isSelected = selectedIndex === index
            return (
              <div
                key={option.id}
                data-option-index={index}
                onClick={() => onSelect(option)}
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
                    {option.label}
                  </span>
                  {/* Show path for files, description for others */}
                  {(option.path || option.description) && (
                    <span
                      className="text-muted-foreground flex-1 min-w-0 ml-2 overflow-hidden text-[10px] truncate"
                    >
                      {option.type === "file" || option.type === "folder"
                        ? option.path
                        : option.description}
                    </span>
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
            ? `No items matching "${debouncedSearchText}"`
            : "No items available"}
        </div>
      )}
    </div>,
    document.body
  )
})
