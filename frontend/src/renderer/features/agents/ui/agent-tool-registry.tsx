"use client"

import {
  Eye,
  FileCode2,
  FolderSearch,
  GitBranch,
  List,
  ListTodo,
  LogOut,
  Minimize2,
  Plus,
  RefreshCw,
  Terminal,
  XCircle,
} from "lucide-react"
import {
  CustomTerminalIcon,
  EyeIcon,
  GlobeIcon,
  IconEditFile,
  PlanningIcon,
  SearchIcon,
  SparklesIcon,
  WriteFileIcon,
} from "../../../components/ui/icons"

export type ToolVariant = "simple" | "collapsible"

/**
 * Generic tool part structure.
 * Note: `any` is used here because each tool has its own specific Part interface
 * (e.g., ThinkingToolPart, TaskToolPart) with different input/output shapes.
 * The registry needs to handle all tool types generically, so we use `any` to
 * allow TypeScript to accept any tool-specific part structure.
 */
export interface ToolPart {
  type?: string
  state?: string
  input?: any
  output?: any
  [key: string]: any
}

export interface ToolMeta {
  icon: React.ComponentType<{ className?: string }>
  title: (part: ToolPart) => string
  subtitle?: (part: ToolPart) => string
  tooltipContent?: (part: ToolPart, projectPath?: string) => string
  variant: ToolVariant
}

export function getToolStatus(part: ToolPart, chatStatus?: string) {
  const basePending =
    part.state !== "output-available" && part.state !== "output-error" && part.state !== "result"
  const isError =
    part.state === "output-error" ||
    (part.state === "output-available" && part.output?.success === false)
  const isSuccess = part.state === "output-available" && !isError
  // Critical: if chat stopped streaming, pending tools should show as complete
  // Include "submitted" status - this is when request was sent but streaming hasn't started yet
  const isActivelyStreaming = chatStatus === "streaming" || chatStatus === "submitted"
  const isPending = basePending && isActivelyStreaming
  // Tool was in progress but chat stopped streaming (user interrupted)
  // Only mark as interrupted if:
  // 1. Tool is still pending (not completed/errored)
  // 2. Chat is not actively streaming
  // 3. Chat has a defined status (not initial/undefined state)
  // 4. Chat is not in a normal completion state (input-streaming means waiting for next tool)
  // 5. Tool was actually in-progress (not just created but never started)
  const wasInProgress = part.state === "input-streaming" ||
                       part.state === "call" ||
                       part.state === "input-available"
  const isInterrupted = basePending &&
                       !isActivelyStreaming &&
                       chatStatus !== undefined &&
                       chatStatus !== "input-streaming" &&
                       wasInProgress

  return { isPending, isError, isSuccess, isInterrupted }
}

// Utility to get clean display path (remove sandbox/worktree/absolute prefixes)
// projectPath: optional absolute path to the project root, used to compute relative paths
export function getDisplayPath(filePath: string, projectPath?: string): string {
  if (!filePath) return ""

  // If projectPath is provided, strip it to get a project-relative path
  if (projectPath && filePath.startsWith(projectPath)) {
    const relative = filePath.slice(projectPath.length).replace(/^\//, "")
    return relative || filePath.split("/").pop() || filePath
  }

  const prefixes = [
    "/project/sandbox/repo/",
    "/project/sandbox/",
    "/project/",
    "/workspace/",
  ]
  for (const prefix of prefixes) {
    if (filePath.startsWith(prefix)) {
      return filePath.slice(prefix.length)
    }
  }
  // Handle current and legacy worktree paths under ~/.ergatai or ~/.21st
  const worktreeMatch = filePath.match(
    /\.(?:ergatai|21st)\/worktrees\/[^/]+\/[^/]+\/(.+)$/,
  )
  if (worktreeMatch) {
    return worktreeMatch[1]
  }
  // Handle claude-sessions paths: .../claude-sessions/{sessionId}/{folder}/{file}
  const sessionMatch = filePath.match(/claude-sessions\/[^/]+\/(.+)$/)
  if (sessionMatch) {
    return sessionMatch[1]
  }
  if (filePath.startsWith("/")) {
    const parts = filePath.split("/")
    const rootIndicators = ["apps", "packages", "src", "lib", "components"]
    const rootIndex = parts.findIndex((p: string) =>
      rootIndicators.includes(p),
    )
    if (rootIndex > 0) {
      return parts.slice(rootIndex).join("/")
    }
    // For other absolute paths, show last 3 segments to keep it short
    if (parts.length > 3) {
      return parts.slice(-3).join("/")
    }
  }
  return filePath
}

// Planning messages - memoized per part instance to prevent flickering on re-render
const PLANNING_MESSAGES = [
  "Crafting...",
  "Whirring...",
  "Imagining...",
  "Cooking...",
  "Sussing...",
  "Unravelling...",
  "Creating...",
  "Spinning...",
  "Computing...",
  "Synthesizing...",
  "Manifesting...",
]

const planningMessageCache = new WeakMap<object, string>()

function getStablePlanningMessage(part: object): string {
  let cached = planningMessageCache.get(part)
  if (!cached) {
    cached = PLANNING_MESSAGES[Math.floor(Math.random() * PLANNING_MESSAGES.length)]
    planningMessageCache.set(part, cached)
  }
  return cached
}

export const AgentToolRegistry: Record<string, ToolMeta> = {
  "tool-Task": {
    icon: SparklesIcon,
    title: (part) => {
      const { isPending } = getToolStatus(part)
      const isInputStreaming = part.state === "input-streaming"
      if (isInputStreaming) return "Preparing agent"
      const subagentType = part.input?.subagent_type || "Agent"
      return isPending ? `Running ${subagentType}` : `${subagentType} completed`
    },
    subtitle: (part) => {
      // Don't show subtitle while input is still streaming
      if (part.state === "input-streaming") return ""
      const description = part.input?.description || ""
      return description.length > 50
        ? description.slice(0, 47) + "..."
        : description
    },
    variant: "simple",
  },

  "tool-Grep": {
    icon: SearchIcon,
    title: (part) => {
      const { isPending } = getToolStatus(part)
      const isInputStreaming = part.state === "input-streaming"
      if (isInputStreaming) return "Preparing search"
      if (isPending) return "Grepping"

      // Handle different output modes:
      // - "files_with_matches" mode: numFiles > 0, filenames is populated
      // - "content" mode: numFiles = 0, but numLines > 0 and content has matches
      // Only trust these claims when the output actually carries stats —
      // agents with different output shapes would otherwise misrender as "No matches".
      const hasStats =
        part.output != null &&
        typeof part.output === "object" &&
        (part.output.mode !== undefined ||
          part.output.numFiles !== undefined ||
          part.output.numLines !== undefined ||
          Array.isArray(part.output.filenames))
      if (!hasStats) return "Searched"

      const mode = part.output?.mode
      const numFiles = part.output?.numFiles || 0
      const numLines = part.output?.numLines || 0

      if (mode === "content") {
        // In content mode, numFiles is always 0, use numLines instead
        return numLines > 0 ? `Found ${numLines} matches` : "No matches"
      }

      return numFiles > 0 ? `Grepped ${numFiles} files` : "No matches"
    },
    subtitle: (part) => {
      // Don't show subtitle while input is still streaming
      if (part.state === "input-streaming") return ""
      const pattern = part.input?.pattern || ""
      const path = part.input?.path || ""

      if (path) {
        // Show "pattern in path" with shortened path
        const displayPath = getDisplayPath(path)
        const combined = `${pattern} in ${displayPath}`
        return combined.length > 40 ? combined.slice(0, 37) + "..." : combined
      }

      return pattern.length > 40 ? pattern.slice(0, 37) + "..." : pattern
    },
    variant: "simple",
  },

  "tool-Glob": {
    icon: FolderSearch,
    title: (part) => {
      const { isPending } = getToolStatus(part)
      const isInputStreaming = part.state === "input-streaming"
      if (isInputStreaming) return "Preparing search"
      if (isPending) return "Exploring files"

      const numFiles = part.output?.numFiles || 0
      return numFiles > 0 ? `Found ${numFiles} files` : "No files found"
    },
    subtitle: (part) => {
      // Don't show subtitle while input is still streaming
      if (part.state === "input-streaming") return ""
      const pattern = part.input?.pattern || ""
      const targetDir = part.input?.target_directory || ""

      if (targetDir) {
        // Show "pattern in targetDir" with shortened path
        const displayTargetDir = getDisplayPath(targetDir)
        const combined = `${pattern} in ${displayTargetDir}`
        return combined.length > 40 ? combined.slice(0, 37) + "..." : combined
      }

      return pattern.length > 40 ? pattern.slice(0, 37) + "..." : pattern
    },
    variant: "simple",
  },

  "tool-Read": {
    icon: EyeIcon,
    title: (part) => {
      const { isPending } = getToolStatus(part)
      const isInputStreaming = part.state === "input-streaming"
      if (isInputStreaming) return "Preparing to read"
      return isPending ? "Reading" : "Read"
    },
    subtitle: (part) => {
      // Don't show subtitle while input is still streaming
      if (part.state === "input-streaming") return ""
      // Get file path from backend locations
      const filePath = part.input?._locations?.[0]?.path || ""
      if (!filePath) return "" // Don't show "file" placeholder during streaming
      return filePath.split("/").pop() || ""
    },
    tooltipContent: (part, projectPath) => {
      if (part.state === "input-streaming") return ""
      // Get file path from backend locations
      const filePath = part.input?._locations?.[0]?.path || ""
      return getDisplayPath(filePath, projectPath)
    },
    variant: "simple",
  },

  "tool-Edit": {
    icon: IconEditFile,
    title: (part) => {
      const isInputStreaming = part.state === "input-streaming"
      if (isInputStreaming) return "Preparing edit"
      const filePath = part.input?._locations?.[0]?.path || ""
      if (!filePath) return "Edit" // Show "Edit" if no file path yet during streaming
      return filePath.split("/").pop() || "Edit"
    },
    variant: "simple",
  },

  // Cloning indicator - shown while sandbox is being created
  "tool-cloning": {
    icon: GitBranch,
    title: () => "Cloning repo",
    variant: "simple",
  },

  // Planning indicator - shown when streaming starts but no content yet
  "tool-planning": {
    icon: PlanningIcon,
    title: (part) => getStablePlanningMessage(part),
    variant: "simple",
  },

  "tool-Write": {
    icon: WriteFileIcon,
    title: (part) => {
      const isInputStreaming = part.state === "input-streaming"
      if (isInputStreaming) return "Preparing to create"
      return "Create"
    },
    subtitle: (part) => {
      // Don't show subtitle while input is still streaming
      if (part.state === "input-streaming") return ""
      const filePath = part.input?._locations?.[0]?.path || ""
      if (!filePath) return "" // Don't show "file" placeholder during streaming
      return filePath.split("/").pop() || ""
    },
    variant: "simple",
  },

  "tool-Bash": {
    icon: CustomTerminalIcon,
    title: (part) => {
      const { isPending } = getToolStatus(part)
      const isInputStreaming = part.state === "input-streaming"
      if (isInputStreaming) return "Generating command"
      return isPending ? "Running command" : "Ran command"
    },
    subtitle: (part) => {
      // Don't show subtitle while input is still streaming
      if (part.state === "input-streaming") return ""
      const command = part.input?.command || ""
      if (!command) return ""
      // Normalize line continuations, shorten absolute paths, and truncate
      let normalized = command.replace(/\\\s*\n\s*/g, " ").trim()
      // Replace absolute paths that look like project paths with relative versions
      normalized = normalized.replace(/\/(?:Users|home|root)\/[^\s"']+/g, (match: string) => {
        return getDisplayPath(match)
      })
      return normalized.length > 50 ? normalized.slice(0, 47) + "..." : normalized
    },
    variant: "simple",
  },

  "tool-WebFetch": {
    icon: GlobeIcon,
    title: (part) => {
      const { isPending } = getToolStatus(part)
      const isInputStreaming = part.state === "input-streaming"
      if (isInputStreaming) return "Preparing fetch"
      return isPending ? "Fetching" : "Fetched"
    },
    subtitle: (part) => {
      // Don't show subtitle while input is still streaming
      if (part.state === "input-streaming") return ""
      const url = part.input?.url || ""
      try {
        return new URL(url).hostname.replace("www.", "")
      } catch {
        return url.slice(0, 30)
      }
    },
    variant: "simple",
  },

  "tool-WebSearch": {
    icon: SearchIcon,
    title: (part) => {
      const { isPending } = getToolStatus(part)
      const isInputStreaming = part.state === "input-streaming"
      if (isInputStreaming) return "Preparing search"
      return isPending ? "Searching the web" : "Searched the web"
    },
    subtitle: (part) => {
      // Don't show subtitle while input is still streaming
      if (part.state === "input-streaming") return ""
      const query = part.input?.query || ""
      return query.length > 40 ? query.slice(0, 37) + "..." : query
    },
    variant: "collapsible",
  },

  // Planning tools
  "tool-TodoWrite": {
    icon: ListTodo,
    title: (part) => {
      const { isPending } = getToolStatus(part)
      const action = part.input?.action || "update"
      if (isPending) {
        return action === "add" ? "Adding todo" : "Updating todos"
      }
      return action === "add" ? "Added todo" : "Updated todos"
    },
    subtitle: (part) => {
      const todos = part.input?.todos || []
      if (todos.length === 0) return ""
      return `${todos.length} ${todos.length === 1 ? "item" : "items"}`
    },
    variant: "simple",
  },

  // Task management tools
  "tool-TaskCreate": {
    icon: Plus,
    title: (part) => {
      const { isPending } = getToolStatus(part)
      return isPending ? "Creating task" : "Created task"
    },
    subtitle: (part) => {
      const subject = part.input?.subject || ""
      return subject.length > 40 ? subject.slice(0, 37) + "..." : subject
    },
    variant: "simple",
  },

  "tool-TaskUpdate": {
    icon: RefreshCw,
    title: (part) => {
      // Status comes from INPUT (output is just confirmation string)
      const status = part.input?.status
      const { isPending } = getToolStatus(part)
      if (isPending) {
        if (status === "in_progress") return "Starting task"
        if (status === "completed") return "Completing task"
        if (status === "deleted") return "Deleting task"
        return "Updating task"
      }
      if (status === "in_progress") return "Started task"
      if (status === "completed") return "Completed task"
      if (status === "deleted") return "Deleted task"
      return "Updated task"
    },
    subtitle: (part) => {
      const subject = part.input?.subject
      const taskId = part.input?.taskId
      if (subject) {
        return subject.length > 40 ? subject.slice(0, 37) + "..." : subject
      }
      return taskId ? `#${taskId}` : ""
    },
    variant: "simple",
  },

  "tool-TaskGet": {
    icon: Eye,
    title: (part) => {
      const { isPending } = getToolStatus(part)
      return isPending ? "Getting task" : "Got task"
    },
    subtitle: (part) => {
      const subject = part.output?.task?.subject
      const taskId = part.input?.taskId
      if (subject) {
        return subject.length > 40 ? subject.slice(0, 37) + "..." : subject
      }
      return taskId ? `#${taskId}` : ""
    },
    variant: "simple",
  },

  "tool-TaskList": {
    icon: List,
    title: (part) => {
      const { isPending } = getToolStatus(part)
      const count = part.output?.tasks?.length
      if (isPending) return "Listing tasks"
      return count !== undefined ? `Listed ${count} tasks` : "Listed tasks"
    },
    subtitle: () => "",
    variant: "simple",
  },

  "tool-PlanWrite": {
    icon: PlanningIcon,
    title: (part) => {
      const { isPending } = getToolStatus(part)
      const action = part.input?.action || "create"
      const status = part.input?.plan?.status
      if (isPending) {
        if (action === "create") return "Creating plan"
        if (action === "approve") return "Approving plan"
        if (action === "complete") return "Completing plan"
        return "Updating plan"
      }
      if (status === "awaiting_approval") return "Plan ready for review"
      if (status === "approved") return "Plan approved"
      if (status === "completed") return "Plan completed"
      return action === "create" ? "Created plan" : "Updated plan"
    },
    subtitle: (part) => {
      const plan = part.input?.plan
      if (!plan) return ""
      const steps = plan.steps || []
      const completed = steps.filter((s: any) => s.status === "completed").length
      if (plan.title) {
        return steps.length > 0 
          ? `${plan.title} (${completed}/${steps.length})`
          : plan.title
      }
      return steps.length > 0 
        ? `${completed}/${steps.length} steps`
        : ""
    },
    variant: "simple",
  },

  "tool-ExitPlanMode": {
    icon: LogOut,
    title: (part) => {
      const {isPending} = getToolStatus(part)
      return isPending ? "Finishing plan" : "Plan complete"
    },
    subtitle: () => "",
    variant: "simple",
  },

  // Notebook tools
  "tool-NotebookEdit": {
    icon: FileCode2,
    title: (part) => {
      const { isPending } = getToolStatus(part)
      return isPending ? "Editing notebook" : "Edited notebook"
    },
    subtitle: (part) => {
      const filePath = part.input?._locations?.[0]?.path || ""
      if (!filePath) return ""
      return filePath.split("/").pop() || ""
    },
    variant: "simple",
  },

  // Shell management tools
  "tool-BashOutput": {
    icon: Terminal,
    title: (part) => {
      const { isPending } = getToolStatus(part)
      return isPending ? "Getting output" : "Got output"
    },
    subtitle: (part) => {
      const pid = part.input?.pid
      return pid ? `PID: ${pid}` : ""
    },
    variant: "simple",
  },

  "tool-KillShell": {
    icon: XCircle,
    title: (part) => {
      const { isPending } = getToolStatus(part)
      return isPending ? "Stopping shell" : "Stopped shell"
    },
    subtitle: (part) => {
      const pid = part.input?.pid
      return pid ? `PID: ${pid}` : ""
    },
    variant: "simple",
  },

  // Note: ListMcpResources, ReadMcpResource and their "Tool"-suffixed variants
  // are handled by AgentMcpToolCall via parseMcpToolType() for richer output display

  // System tools
  "tool-Compact": {
    icon: Minimize2,
    title: (part) => {
      const isPending =
        part.state !== "output-available" &&
        part.state !== "output-error" &&
        part.state !== "result"
      return isPending ? "Compacting..." : "Compacted"
    },
    variant: "simple",
  },

  // Extended Thinking
  "tool-Thinking": {
    icon: SparklesIcon,
    title: (part) => {
      const { isPending } = getToolStatus(part)
      return isPending ? "Thinking..." : "Thought"
    },
    subtitle: (part) => {
      const text = part.input?.text || ""
      // Show first 50 chars as preview
      return text.length > 50 ? text.slice(0, 47) + "..." : text
    },
    variant: "collapsible",
  },
}

// ============================================================================
// MCP TOOL PARSING
// ============================================================================

const MCP_TOOL_PREFIX = "tool-mcp__"

export type McpToolCategory =
  | "search"
  | "list"
  | "get"
  | "create"
  | "update"
  | "delete"
  | "send"
  | "generate"
  | "other"

export interface McpToolInfo {
  serverName: string
  toolName: string
  displayName: string
  category: McpToolCategory
}

// Built-in MCP tools (not prefixed with mcp__<server>__)
const BUILTIN_MCP_TOOLS: Record<string, McpToolInfo> = {
  "tool-ListMcpResources": { serverName: "mcp", toolName: "list_resources", displayName: "List Resources", category: "list" },
  "tool-ListMcpResourcesTool": { serverName: "mcp", toolName: "list_resources", displayName: "List Resources", category: "list" },
  "tool-ReadMcpResource": { serverName: "mcp", toolName: "read_resource", displayName: "Read Resource", category: "get" },
  "tool-ReadMcpResourceTool": { serverName: "mcp", toolName: "read_resource", displayName: "Read Resource", category: "get" },
}

export function parseMcpToolType(partType: string): McpToolInfo | null {
  // Check built-in MCP tools first
  const builtin = BUILTIN_MCP_TOOLS[partType]
  if (builtin) return builtin

  if (!partType.startsWith(MCP_TOOL_PREFIX)) return null

  const withoutPrefix = partType.slice(MCP_TOOL_PREFIX.length)
  const separatorIndex = withoutPrefix.indexOf("__")
  if (separatorIndex === -1) return null

  const serverName = withoutPrefix.slice(0, separatorIndex)
  const toolName = withoutPrefix.slice(separatorIndex + 2)

  return {
    serverName,
    toolName,
    displayName: formatMcpToolName(toolName),
    category: categorizeMcpTool(toolName),
  }
}

export function formatMcpToolName(toolName: string): string {
  return toolName
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\s+/g, " ")
    .trim()
}

function categorizeMcpTool(toolName: string): McpToolCategory {
  const lower = toolName.toLowerCase()
  if (lower.startsWith("search_") || lower.startsWith("query_")) return "search"
  if (lower.startsWith("list_")) return "list"
  if (lower.startsWith("get_") || lower.startsWith("fetch_") || lower.startsWith("retrieve_")) return "get"
  if (lower.startsWith("create_") || lower.startsWith("add_") || lower.startsWith("draft_")) return "create"
  if (lower.startsWith("update_") || lower.startsWith("modify_") || lower.startsWith("manage_")) return "update"
  if (lower.startsWith("delete_") || lower.startsWith("remove_")) return "delete"
  if (lower.startsWith("send_")) return "send"
  if (lower.startsWith("generate_")) return "generate"
  return "other"
}
