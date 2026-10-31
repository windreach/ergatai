"use client"

import { useAtomValue } from "jotai"
import { ListTree, MoreHorizontal } from "lucide-react"
import { memo, useCallback, useContext, useMemo, useState } from "react"
import { normalizeCodexToolPart } from "../../../../shared/codex-tool-normalizer"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../../components/ui/dropdown-menu"
import { CollapseIcon, ExpandIcon, PlanIcon } from "../../../components/ui/icons"
import { TextShimmer } from "../../../components/ui/text-shimmer"
import { ChatMarkdownRenderer } from "../../../components/chat-markdown-renderer"
import { cn } from "../../../lib/utils"
import { selectedWorkspaceAtom, showMessageJsonAtom } from "../atoms"
import { GroupAgentMessageHeader } from "../collaboration/group-agent-message-header"
import { GroupAgentMentionTool } from "../collaboration/group-agent-mention-tool"
import { useGroupChat } from "../collaboration/group-chat-context"
import { MessageJsonDisplay } from "../ui/message-json-display"
import { AgentAskUserQuestionTool } from "../ui/agent-ask-user-question-tool"
import { AgentBashTool } from "../ui/agent-bash-tool"
import { AgentGrepTool } from "../ui/agent-grep-tool"
import { AgentEditTool } from "../ui/agent-edit-tool"
import { AgentExploringGroup } from "../ui/agent-exploring-group"
import { AgentTaskToolsGroup } from "../ui/agent-task-tools"
import { AgentPlanFileTool } from "../ui/agent-plan-file-tool"
import { isPlanFile } from "../ui/agent-tool-utils"
import { messageTypeVariantClass } from "../lib/message-type-styles"
import type { CoreAgentId } from "../lib/agent-contract-api"
import {
  AgentMessageUsage,
  type AgentMessageMetadata,
} from "../ui/agent-message-usage"
import { AgentPlanTool } from "../ui/agent-plan-tool"
import { AgentTaskTool } from "../ui/agent-task-tool"
import { AgentThinkingTool } from "../ui/agent-thinking-tool"
import { AgentTodoTool } from "../ui/agent-todo-tool"
import { AgentMcpToolCall } from "../ui/agent-mcp-tool-call"
import { AgentToolCall } from "../ui/agent-tool-call"
import {
  AgentToolRegistry,
  getToolStatus,
  parseMcpToolType,
} from "../ui/agent-tool-registry"
import { AgentWebFetchTool } from "../ui/agent-web-fetch-tool"
import { AgentWebSearchCollapsible } from "../ui/agent-web-search-collapsible"
import {
  CopyButton,
  getMessageTextContent,
} from "../ui/message-action-buttons"
import { useFileOpen } from "../mentions"
import { GitActivityBadges } from "../ui/git-activity-badges"
import { ForkContext } from "./fork-context"
import { MemoizedTextPart } from "./memoized-text-part"
import { InterAgentRepliesDisclosure } from "./inter-agent-replies-disclosure"

// Map first word of an ACP tool title to a canonical Claude Code tool type.
// Codex tool calls arrive with type = "tool-Read README.md", "tool-Run echo ---",
// "tool-List /Users/...", "tool-Search *.test.ts in backend", etc.
// input.toolName contains the full ACP title, input.args the raw codex parameters.
const ACP_VERB_TO_TOOL_TYPE: Record<string, string> = {
  Read: "Read",
  Run: "Bash",
  List: "Glob",
  Search: "Grep",
  Grep: "Grep",
  Glob: "Glob",
  Edit: "Edit",
  Write: "Write",
  Thought: "Thinking",
  Fetch: "WebFetch",
  Terminal: "Bash",
}

// Check if a part.type looks like an ACP title-based type (e.g. "tool-Read README.md")
// Returns the verb if matched, null otherwise
function getAcpVerb(partType: string): string | null {
  if (!partType.startsWith("tool-")) return null
  const afterTool = partType.slice(5) // strip "tool-"
  // Check if it starts with a known verb followed by space or end-of-string
  for (const verb of Object.keys(ACP_VERB_TO_TOOL_TYPE)) {
    if (afterTool === verb || afterTool.startsWith(verb + " ")) {
      return verb
    }
  }
  // Case-insensitive pass — some agents lowercase tool titles (e.g. "tool-grep foo")
  const lowered = afterTool.toLowerCase()
  for (const verb of Object.keys(ACP_VERB_TO_TOOL_TYPE)) {
    const loweredVerb = verb.toLowerCase()
    if (lowered === loweredVerb || lowered.startsWith(loweredVerb + " ")) {
      return verb
    }
  }
  return null
}

// Some agents expose tools under lowercase exact names (e.g. "tool-grep").
// Map them to the canonical registry types so they render titles and subtitles
// (e.g. the searched pattern) instead of the muted text fallback.
const LOWERCASE_EXACT_TOOL_TYPES: Record<string, string> = {
  "tool-bash": "tool-Bash",
  "tool-grep": "tool-Grep",
  "tool-glob": "tool-Glob",
  "tool-read": "tool-Read",
  "tool-write": "tool-Write",
  "tool-edit": "tool-Edit",
}

// Normalize ACP/codex tool parts into canonical types so grouping and rendering work.
// Handles two formats:
// 1. Streaming: type="tool-acp.acp_provider_agent_dynamic_tool", input={toolName, args}
// 2. Persisted/live: type="tool-Read README.md", input={toolName, args}
function normalizeAcpParts(parts: any[]): any[] {
  return parts.map((part) => {
    if (!part.type?.startsWith("tool-")) return part

    // Some agents expose a shell tool literally named "Terminal" (AI SDK type
    // "tool-Terminal") with the same input/output shape as Bash. Render it
    // through the interactive Bash tool instead of the muted text fallback.
    if (part.type.toLowerCase() === "tool-terminal") {
      const input =
        part.input && typeof part.input === "object"
          ? (part.input as Record<string, any>)
          : {}
      return {
        ...part,
        type: "tool-Bash",
        input: {
          ...input,
          command: input.command ?? input.cmd ?? "",
        },
      }
    }

    // Lowercase tool names (e.g. "tool-grep") → canonical registry types
    const lowercaseCanonicalType = LOWERCASE_EXACT_TOOL_TYPES[part.type]
    if (lowercaseCanonicalType) {
      return { ...part, type: lowercaseCanonicalType }
    }

    // Guard: only process ACP parts, not Claude Code parts.
    // ACP parts have: input.toolName, or space in type (e.g. "tool-Read README.md"),
    // or the proxy tool name. Claude Code parts have exact types like "tool-Read".
    const isAcpPart = part.input?.toolName || part.type.includes(" ") || part.type === "tool-acp.acp_provider_agent_dynamic_tool"
    if (!isAcpPart) return part

    const partInput =
      part.input && typeof part.input === "object"
        ? (part.input as Record<string, any>)
        : {}

    // Determine the ACP title — either from the type itself or from input.toolName
    let title: string | null = null
    let args: Record<string, any> = {}

    // Case 1: type is already the title-based type (e.g. "tool-Read README.md")
    const verb = getAcpVerb(part.type)
    if (verb) {
      title = partInput.toolName || part.type.slice(5)
      args =
        partInput.args && typeof partInput.args === "object"
          ? (partInput.args as Record<string, any>)
          : partInput
    }

    // Case 2: type is the ACP proxy tool name
    if (!verb && part.type === "tool-acp.acp_provider_agent_dynamic_tool") {
      let input = part.input
      if (typeof input === "string") {
        try { input = JSON.parse(input) } catch { return part }
      }
      const parsedInput =
        input && typeof input === "object"
          ? (input as Record<string, any>)
          : {}
      if (parsedInput.toolName) {
        title = parsedInput.toolName
        args =
          parsedInput.args && typeof parsedInput.args === "object"
            ? (parsedInput.args as Record<string, any>)
            : parsedInput
      }
    }

    if (!title) return part

    // Parse the first word of the title to get canonical tool type
    const spaceIdx = title.indexOf(" ")
    const titleVerb = spaceIdx === -1 ? title : title.slice(0, spaceIdx)
    const detail = spaceIdx === -1 ? "" : title.slice(spaceIdx + 1)
    const canonicalType = ACP_VERB_TO_TOOL_TYPE[titleVerb]

    if (!canonicalType) return part

    // Enrich input with fields that the tool registry expects for display
    const enrichedInput: Record<string, any> = { ...args, _acpTitle: title, _acpDetail: detail }

    // For Bash tools, handle array command format from Codex
    if (canonicalType === "Bash") {
      // Codex passes command as array ['/bin/zsh', '-lc', 'actual command'] — extract shell string
      if (Array.isArray(enrichedInput.command)) {
        enrichedInput.command = enrichedInput.command[enrichedInput.command.length - 1] || detail
      } else if (!enrichedInput.command && detail) {
        enrichedInput.command = detail
      }
    }
    if (canonicalType === "Grep" && !enrichedInput.pattern && detail) {
      enrichedInput.pattern = detail
    }
    if (canonicalType === "Glob" && !enrichedInput.pattern && detail) {
      enrichedInput.pattern = detail
    }

    return {
      ...part,
      type: `tool-${canonicalType}`,
      input: enrichedInput,
      output: part.output,
    }
  })
}

// Exploring tools - these get grouped when 3+ consecutive
const EXPLORING_TOOLS = new Set([
  "tool-Read",
  "tool-Grep",
  "tool-Glob",
  "tool-WebSearch",
  "tool-WebFetch",
])

// Task management tools - these get grouped when consecutive
const TASK_TOOLS = new Set([
  "tool-TaskCreate",
  "tool-TaskUpdate",
  "tool-TaskGet",
  "tool-TaskList",
])

const STREAMING_REASONING_STATES = new Set(["streaming", "in_progress", "input-streaming"])
const DONE_REASONING_STATES = new Set(["done", "completed", "result", "output-available"])
const ERROR_REASONING_STATES = new Set(["error", "output-error"])

function mapReasoningStateToThinkingState(state: unknown): string {
  if (typeof state !== "string") {
    return "output-available"
  }

  const normalized = state.trim().toLowerCase()
  if (STREAMING_REASONING_STATES.has(normalized)) return "input-streaming"
  if (DONE_REASONING_STATES.has(normalized)) return "output-available"
  if (ERROR_REASONING_STATES.has(normalized)) return "output-error"
  return "output-available"
}

function getThinkingText(part: any): string {
  if (typeof part?.input?.text === "string") return part.input.text
  if (typeof part?.text === "string") return part.text
  return ""
}

function toThinkingToolPart(part: any, messageId: string | undefined, index: number): any {
  const normalizedState = mapReasoningStateToThinkingState(part.state)
  const text = getThinkingText(part)
  const normalizedPart = {
    ...part,
    type: "tool-Thinking",
    toolCallId:
      typeof part.toolCallId === "string" && part.toolCallId.length > 0
        ? part.toolCallId
        : typeof part.id === "string" && part.id.length > 0
          ? part.id
          : `reasoning-${messageId || "message"}-${index}`,
    toolName: typeof part.toolName === "string" ? part.toolName : "Thinking",
    input: {
      ...(part.input && typeof part.input === "object" ? part.input : {}),
      text,
    },
    state: normalizedState,
  }

  if (normalizedState !== "output-available") {
    return normalizedPart
  }

  const completedResult = { completed: true }
  return {
    ...normalizedPart,
    result: normalizedPart.result ?? completedResult,
    output: normalizedPart.output ?? completedResult,
  }
}


// Group consecutive exploring tools into exploring-group
function groupExploringTools(parts: any[], nestedToolIds: Set<string>): any[] {
  const result: any[] = []
  let currentGroup: any[] = []

  for (const part of parts) {
    const isNested = part.toolCallId && nestedToolIds.has(part.toolCallId)

    if (EXPLORING_TOOLS.has(part.type) && !isNested) {
      currentGroup.push(part)
    } else {
      if (currentGroup.length >= 3) {
        result.push({ type: "exploring-group", parts: currentGroup })
      } else {
        result.push(...currentGroup)
      }
      currentGroup = []
      result.push(part)
    }
  }
  if (currentGroup.length >= 3) {
    result.push({ type: "exploring-group", parts: currentGroup })
  } else {
    result.push(...currentGroup)
  }
  return result
}

// Group consecutive task tools into task-group
function groupTaskTools(parts: any[], nestedToolIds: Set<string>): any[] {
  const result: any[] = []
  let currentGroup: any[] = []

  for (const part of parts) {
    const isNested = part.toolCallId && nestedToolIds.has(part.toolCallId)

    if (TASK_TOOLS.has(part.type) && !isNested) {
      currentGroup.push(part)
    } else {
      if (currentGroup.length >= 1) {
        result.push({ type: "task-group", parts: currentGroup })
      }
      currentGroup = []
      result.push(part)
    }
  }
  if (currentGroup.length >= 1) {
    result.push({ type: "task-group", parts: currentGroup })
  }
  return result
}

// Collapsible steps component
interface CollapsibleStepsProps {
  stepsCount: number
  children: React.ReactNode
  defaultExpanded?: boolean
}

function CollapsibleSteps({
  stepsCount,
  children,
  defaultExpanded = false,
}: CollapsibleStepsProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded)

  if (stepsCount === 0) return null

  return (
    <div className="mb-2" data-collapsible-steps="true">
      <div
        className="flex items-center justify-between rounded-md py-0.5 px-2 cursor-pointer hover:bg-muted/50 transition-colors"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <ListTree className="w-3.5 h-3.5 flex-shrink-0" />
          <span className="font-medium whitespace-nowrap">
            {stepsCount} {stepsCount === 1 ? "step" : "steps"}
          </span>
        </div>
        <button
          className="p-1 rounded-md hover:bg-accent transition-[background-color,transform] duration-150 ease-out active:scale-95"
          onClick={(e) => {
            e.stopPropagation()
            setIsExpanded(!isExpanded)
          }}
        >
          <div className="relative w-4 h-4">
            <ExpandIcon
              className={cn(
                "absolute inset-0 w-4 h-4 text-muted-foreground transition-[opacity,transform] duration-200 ease-out",
                isExpanded ? "opacity-0 scale-75" : "opacity-100 scale-100",
              )}
            />
            <CollapseIcon
              className={cn(
                "absolute inset-0 w-4 h-4 text-muted-foreground transition-[opacity,transform] duration-200 ease-out",
                isExpanded ? "opacity-100 scale-100" : "opacity-0 scale-75",
              )}
            />
          </div>
        </button>
      </div>
      {isExpanded && <div className="mt-1 space-y-1.5">{children}</div>}
    </div>
  )
}

// ============================================================================
// ASSISTANT MESSAGE ITEM - MEMOIZED BY MESSAGE ID + PARTS LENGTH
// ============================================================================

export interface AssistantMessageItemProps {
  message: any
  isLastMessage: boolean
  isStreaming: boolean
  status: string
  isMobile: boolean
  conversationId: string
  chatId: string
  sandboxSetupStatus?: "cloning" | "ready" | "error"
  agentIdentity?: { id: string; name: string }
  showInterAgentReplies?: boolean
}

// P1: The message store now guarantees immutable message snapshots (atoms
// hold deep-frozen clones replaced only on real content change), so plain
// shallow prop comparison is sufficient — no external change-tracking cache.

export const AssistantMessageItem = memo(function AssistantMessageItem({
  message,
  isLastMessage,
  isStreaming,
  status,
  isMobile,
  conversationId,
  chatId,
  sandboxSetupStatus = "ready",
  agentIdentity,
  showInterAgentReplies = false,
}: AssistantMessageItemProps) {
  const showMessageJson = useAtomValue(showMessageJsonAtom)
  const selectedWorkspace = useAtomValue(selectedWorkspaceAtom)
  const projectPath = selectedWorkspace?.path
  const onOpenFile = useFileOpen()
  const onFork = useContext(ForkContext)
  const isDev = import.meta.env.DEV
  const { agents: groupChatAgents, isGroupChat } = useGroupChat()
  // Normalize ACP/codex tool parts into canonical types (e.g. "tool-Read README.md" → "tool-Read").
  // Note: no useMemo — AI SDK mutates parts in-place, so the array reference
  // doesn't change and useMemo would return stale results.
  const messageParts = normalizeAcpParts(
    (message?.parts || []).map((part: any) =>
      normalizeCodexToolPart(part) as any,
    ),
  )

  const contentParts = useMemo(() =>
    messageParts.filter((p: any) => p.type !== "step-start"),
    [messageParts]
  )

  const shouldShowPlanning =
    sandboxSetupStatus === "ready" &&
    isStreaming &&
    isLastMessage &&
    contentParts.length === 0

  const { nestedToolsMap, nestedToolIds, orphanTaskGroups, orphanToolCallIds, orphanFirstToolCallIds } = useMemo(() => {
    const nestedToolsMap = new Map<string, any[]>()
    const nestedToolIds = new Set<string>()
    const taskPartIds = new Set(
      messageParts
        .filter((p: any) => p.type === "tool-Task" && p.toolCallId)
        .map((p: any) => p.toolCallId)
    )
    const orphanTaskGroups = new Map<string, { parts: any[]; firstToolCallId: string }>()
    const orphanToolCallIds = new Set<string>()
    const orphanFirstToolCallIds = new Set<string>()

    for (const part of messageParts) {
      if (part.toolCallId?.includes(":")) {
        const parentId = part.toolCallId.split(":")[0]
        if (taskPartIds.has(parentId)) {
          if (!nestedToolsMap.has(parentId)) {
            nestedToolsMap.set(parentId, [])
          }
          nestedToolsMap.get(parentId)!.push(part)
          nestedToolIds.add(part.toolCallId)
        } else {
          let group = orphanTaskGroups.get(parentId)
          if (!group) {
            group = { parts: [], firstToolCallId: part.toolCallId }
            orphanTaskGroups.set(parentId, group)
            orphanFirstToolCallIds.add(part.toolCallId)
          }
          group.parts.push(part)
          orphanToolCallIds.add(part.toolCallId)
        }
      }
    }

    return { nestedToolsMap, nestedToolIds, orphanTaskGroups, orphanToolCallIds, orphanFirstToolCallIds }
  }, [messageParts])

  // Collect all plan operations (Write/Edit) for unified handling
  const planOpsSummary = useMemo(() => {
    const operations: Array<{ type: "write" | "edit"; part: any; index: number }> = []

    for (let i = 0; i < messageParts.length; i++) {
      const part = messageParts[i]

      // Only process Write/Edit tools for plan operations
      if (part.type !== "tool-Write" && part.type !== "tool-Edit") {
        continue
      }

      // Extract file path from locations (backend provides locations, not file_path)
      const locations = part.input?._locations
      const filePath = locations?.[0]?.path

      if (!filePath) {
        // Tool failed or backend didn't provide locations - skip silently
        // This can happen when tool_call_error occurs before tool_call_complete
        continue
      }

      if (isPlanFile(filePath)) {
        operations.push({
          type: part.type === "tool-Write" ? "write" : "edit",
          part,
          index: i,
        })
      }
    }

    if (operations.length === 0) {
      return { operations: [], hasAnyPlanOperation: false, isStreaming: false, lastOperationType: null as "write" | "edit" | null }
    }

    const isStreaming = operations.some(op =>
      op.part.state === "input-streaming" || op.part.state === "pending"
    )

    const lastOp = operations[operations.length - 1]

    return {
      operations,
      hasAnyPlanOperation: true,
      isStreaming,
      lastOperationType: lastOp.type,
    }
  }, [messageParts])

  // Collapsing logic: collapse only if final text exists after tools
  const { shouldCollapse, visibleStepsCount, collapseBeforeIndex } = useMemo(() => {
    let lastToolIndex = -1
    let lastTextIndex = -1

    for (let i = 0; i < messageParts.length; i++) {
      const part = messageParts[i]
      // Ignore ExitPlanMode - it's not a real tool for the user
      if (part.type?.startsWith("tool-") && part.type !== "tool-ExitPlanMode") {
        lastToolIndex = i
      }
      if (part.type === "text" && part.text?.trim()) {
        lastTextIndex = i
      }
    }

    const hasToolsAndFinalText = lastToolIndex !== -1 && lastTextIndex > lastToolIndex
    const finalTextIndex = hasToolsAndFinalText ? lastTextIndex : -1
    const hasFinalText =
      finalTextIndex !== -1 &&
      !isGroupChat &&
      (!isStreaming || !isLastMessage)

    // Collapse only when there's final text after tools
    const shouldCollapse = hasFinalText
    const collapseBeforeIndex = hasFinalText ? finalTextIndex : -1

    // Calculate visible steps count for collapsible header
    const stepParts = shouldCollapse && collapseBeforeIndex !== -1 ? messageParts.slice(0, collapseBeforeIndex) : []
    const visibleStepsCount = stepParts.filter((p: any) => {
      if (p.type === "step-start") return false
      if (p.type === "tool-TaskOutput") return false
      if (p.type === "tool-ExitPlanMode") return false
      if (p.toolCallId && nestedToolIds.has(p.toolCallId)) return false
      if (p.toolCallId && orphanToolCallIds.has(p.toolCallId) && !orphanFirstToolCallIds.has(p.toolCallId)) return false
      if (p.type === "text" && !p.text?.trim()) return false
      return true
    }).length

    return { shouldCollapse, visibleStepsCount, collapseBeforeIndex }
  }, [messageParts, isStreaming, isLastMessage, nestedToolIds, orphanToolCallIds, orphanFirstToolCallIds])

  // Check if any plan operation is in collapsed steps (before collapseBeforeIndex)
  const hasPlanInCollapsedSteps = useMemo(() => {
    if (!shouldCollapse || collapseBeforeIndex === -1) return false
    return planOpsSummary.operations.some(op => op.index < collapseBeforeIndex)
  }, [shouldCollapse, collapseBeforeIndex, planOpsSummary.operations])

  // Get the last plan operation from collapsed steps for showing card
  const lastCollapsedPlanOp = useMemo(() => {
    if (!hasPlanInCollapsedSteps) return null
    const collapsedOps = planOpsSummary.operations.filter(op => op.index < collapseBeforeIndex)
    return collapsedOps[collapsedOps.length - 1] || null
  }, [hasPlanInCollapsedSteps, planOpsSummary.operations, collapseBeforeIndex])

  const stepParts = useMemo(() => {
    if (!shouldCollapse || collapseBeforeIndex === -1) return []
    return messageParts.slice(0, collapseBeforeIndex)
  }, [messageParts, shouldCollapse, collapseBeforeIndex])

  const finalParts = useMemo(() => {
    if (!shouldCollapse || collapseBeforeIndex === -1) return messageParts
    return messageParts.slice(collapseBeforeIndex)
  }, [messageParts, shouldCollapse, collapseBeforeIndex])

  const hasTextContent = useMemo(() =>
    messageParts.some((p: any) => p.type === "text" && p.text?.trim()),
    [messageParts]
  )

  const msgMetadata = message?.metadata as AgentMessageMetadata
  const messageType = msgMetadata?.messageType
  const metadataAgent = msgMetadata?.agentName
    ? {
        id: msgMetadata.agentId ?? msgMetadata.senderAgentId ?? "unknown-agent",
        name: msgMetadata.agentName,
      }
    : msgMetadata?.senderAgentName
    ? {
        id: msgMetadata.agentId ?? msgMetadata.senderAgentId ?? "unknown-agent",
        name: msgMetadata.senderAgentName,
      }
    : null
  const groupAgent = isGroupChat
    ? groupChatAgents.find(
        (agent) => agent.id === msgMetadata?.agentId,
      ) ?? (agentIdentity ?? metadataAgent ?? groupChatAgents[0])
    : agentIdentity
      ? { id: agentIdentity.id, name: agentIdentity.name }
      : null

  const renderPart = useCallback((part: any, idx: number, isFinal = false) => {
    if (part.type === "step-start") return null
    if (part.type === "tool-TaskOutput") return null
    if (part.type === "control-end") return null

    if (part.toolCallId && orphanToolCallIds.has(part.toolCallId)) {
      if (!orphanFirstToolCallIds.has(part.toolCallId)) return null
      const parentId = part.toolCallId.split(":")[0]
      const group = orphanTaskGroups.get(parentId)
      if (group) {
        return (
          <AgentTaskTool
            key={idx}
            part={{
              type: "tool-Task",
              toolCallId: parentId,
              input: { subagent_type: "unknown-agent", description: "Incomplete task" },
            }}
            nestedTools={group.parts}
            chatStatus={status}
          />
        )
      }
    }

    if (part.toolCallId && nestedToolIds.has(part.toolCallId)) return null
    if (part.type === "exploring-group") return null

    if (part.type === "text") {
      if (!part.text?.trim()) return null
      const isFinalText = isFinal && idx === collapseBeforeIndex
      const isTextStreaming = isLastMessage && isStreaming
      return (
        <MemoizedTextPart
          key={idx}
          text={part.text}
          messageId={message.id}
          partIndex={idx}
          isStreaming={isTextStreaming}
        />
      )
    }

    if (part.type === "tool-Task") {
      const nestedTools = nestedToolsMap.get(part.toolCallId) || []
      return <AgentTaskTool key={idx} part={part} nestedTools={nestedTools} chatStatus={status} />
    }

    // Group agent @mention — intercept send_message MCP tool call
    if (part.type?.includes("send_message")) {
      const targetAgent =
        part.input?.target_agent_id as string | undefined
        ?? (part.type.match(/target_agent_id[='"]+(\w+)/)?.[1])
        ?? "agent"
      const sideMessage = part.sideMessage as
        | { text?: string; messageId?: string }
        | undefined
      const message = sideMessage?.text ?? (part.input?.message as string | undefined) ?? ""
      return (
        <div
          key={idx}
          className="max-w-full rounded-md border border-border/60 bg-muted/20 px-2 py-1.5 text-xs"
        >
          <div className="flex items-center gap-1 text-muted-foreground">
            <span className="font-medium text-foreground">@{targetAgent}</span>
            <span>send_message</span>
          </div>
          {message && (
            <div className="mt-1 max-h-44 overflow-y-auto rounded-sm bg-background/60 px-2 py-1.5">
              <ChatMarkdownRenderer content={message} size="sm" />
            </div>
          )}
        </div>
      )
    }

    if (part.type === "tool-Bash") return <AgentBashTool key={idx} part={part} messageId={message.id} partIndex={idx} chatStatus={status} />
    if (part.type === "tool-Grep") return <AgentGrepTool key={idx} part={part} messageId={message.id} partIndex={idx} chatStatus={status} />
    if (part.type === "reasoning" || part.type === "tool-Thinking") {
      return (
        <AgentThinkingTool
          key={idx}
          part={toThinkingToolPart(part, message?.id, idx)}
          chatStatus={status}
        />
      )
    }

    // Plan files: unified handling
    // - In collapsed steps: all show mini indicator, last collapsed op's card shown separately after finalParts
    // - In final parts: all but last show mini indicator, last shows full card
    if (part.type === "tool-Write" || part.type === "tool-Edit") {
      const filePath = part.input?._locations?.[0]?.path
      if (!filePath) return null
      if (isPlanFile(filePath)) {
        // Use part.toolCallId to find operation since idx may be adjusted for collapsed parts
        const opIndex = planOpsSummary.operations.findIndex(op => op.part.toolCallId === part.toolCallId)
        if (opIndex === -1) return null

        const originalIndex = planOpsSummary.operations[opIndex]?.index ?? -1
        const isInCollapsedSteps = shouldCollapse && collapseBeforeIndex !== -1 && originalIndex < collapseBeforeIndex
        const isLastCollapsedOp = lastCollapsedPlanOp?.part.toolCallId === part.toolCallId
        const isLastOperation = opIndex === planOpsSummary.operations.length - 1

        // If this is the last collapsed plan op, hide it here (card shown after CollapsibleSteps)
        if (isInCollapsedSteps && isLastCollapsedOp) {
          return null
        }

        // Show mini indicator for:
        // - All operations in collapsed steps (except last collapsed, handled above)
        // - All operations except last in final parts
        const showMiniIndicator = isInCollapsedSteps || !isLastOperation

        if (showMiniIndicator) {
          const isWrite = part.type === "tool-Write"
          const { isPending } = getToolStatus(part, status)
          const isOpStreaming = isPending || (part.state === "input-streaming" && isStreaming && isLastMessage)

          return (
            <div key={idx} className="flex items-center gap-1.5 px-2 py-0.5">
              <span className="text-xs text-muted-foreground">
                {isOpStreaming ? (
                  <TextShimmer as="span" duration={1.2}>
                    {isWrite ? "Creating plan..." : "Updating plan..."}
                  </TextShimmer>
                ) : (
                  isWrite ? "Created plan" : "Updated plan"
                )}
              </span>
            </div>
          )
        }

        // Last operation in final parts: show full card
        return (
          <AgentPlanFileTool
            key={idx}
            part={part}
            chatStatus={status}
            conversationId={conversationId}
            isEdit={part.type === "tool-Edit"}
          />
        )
      }
    }

    if (part.type === "tool-Edit") return <AgentEditTool key={idx} part={part} messageId={message.id} partIndex={idx} chatStatus={status} />
    if (part.type === "tool-Write") return <AgentEditTool key={idx} part={part} messageId={message.id} partIndex={idx} chatStatus={status} />
    if (part.type === "tool-WebSearch") return <AgentWebSearchCollapsible key={idx} part={part} chatStatus={status} />
    if (part.type === "tool-WebFetch") return <AgentWebFetchTool key={idx} part={part} chatStatus={status} />
    if (part.type === "tool-PlanWrite") return <AgentPlanTool key={idx} part={part} chatStatus={status} />

    // ExitPlanMode tool is hidden - plan is shown in sidebar instead
    if (part.type === "tool-ExitPlanMode") {
      return null
    }

    if (part.type === "tool-TodoWrite") {
      return <AgentTodoTool key={idx} part={part} chatStatus={status} conversationId={conversationId} />
    }

    if (part.type === "tool-AskUserQuestion") {
      const { isPending, isError } = getToolStatus(part, status)
      return (
        <AgentAskUserQuestionTool
          key={idx}
          input={part.input}
          result={part.result}
          errorText={(part.errorText as string | undefined) || (part.error as string | undefined)}
          state={isPending ? "call" : "result"}
          isError={isError}
          isStreaming={isStreaming && isLastMessage}
          toolCallId={part.toolCallId}
        />
      )
    }

    if (part.type in AgentToolRegistry) {
      const meta = AgentToolRegistry[part.type]
      const { isPending, isError } = getToolStatus(part, status)
      const filePath = part.input?._locations?.[0]?.path
      const handleClick = part.type === "tool-Read" && onOpenFile && filePath
        ? () => onOpenFile(filePath)
        : undefined
      return (
        <AgentToolCall
          key={idx}
          icon={meta.icon}
          title={meta.title(part)}
          subtitle={meta.subtitle?.(part)}
          tooltipContent={meta.tooltipContent?.(part, projectPath)}
          isPending={isPending}
          isError={isError}
          onClick={handleClick}
        />
      )
    }

    // MCP tool calls (pattern: tool-mcp__<server>__<tool>)
    const mcpInfo = parseMcpToolType(part.type)
    if (mcpInfo) {
      return (
        <AgentMcpToolCall
          key={idx}
          part={part}
          mcpInfo={mcpInfo}
          chatStatus={status}
        />
      )
    }

    if (part.type?.startsWith("tool-")) {
      return (
        <div key={idx} className="text-xs text-muted-foreground py-0.5 px-2">
          {part.type.replace("tool-", "")}
        </div>
      )
    }

    return null
  }, [nestedToolsMap, nestedToolIds, orphanToolCallIds, orphanFirstToolCallIds, orphanTaskGroups, collapseBeforeIndex, visibleStepsCount, status, isLastMessage, isStreaming, conversationId, message.id, planOpsSummary, shouldCollapse, lastCollapsedPlanOp])

  if (!message) return null

  return (
    <div
      data-testid="agent-message"
      data-assistant-message-id={message.id}
      className={cn(
        "group/message w-full mb-4",
        messageTypeVariantClass(messageType),
      )}
    >
      {groupAgent && (
        <GroupAgentMessageHeader
          agentId={groupAgent.id as CoreAgentId}
          agentName={msgMetadata?.agentName || groupAgent.name}
        />
      )}
      <div className="flex flex-col gap-1.5">
        {isGroupChat && groupAgent && shouldCollapse && (
          <div className="px-2 text-xs text-muted-foreground">
            {visibleStepsCount} {visibleStepsCount === 1 ? "step" : "steps"}
          </div>
        )}

        {!isGroupChat && shouldCollapse && visibleStepsCount > 0 && (
          <CollapsibleSteps stepsCount={visibleStepsCount}>
            {(() => {
              // Apply both grouping functions: first task tools, then exploring tools
              const taskGrouped = groupTaskTools(stepParts, nestedToolIds)
              const grouped = groupExploringTools(taskGrouped, nestedToolIds)
              return grouped.map((part: any, idx: number) => {
                if (part.type === "exploring-group") {
                  const isLast = idx === grouped.length - 1
                  const isGroupStreaming = isStreaming && isLastMessage && isLast
                  return (
                    <AgentExploringGroup
                      key={idx}
                      parts={part.parts}
                      chatStatus={status}
                      isStreaming={isGroupStreaming}
                    />
                  )
                }
                if (part.type === "task-group") {
                  const isLast = idx === grouped.length - 1
                  const isGroupStreaming = isStreaming && isLastMessage && isLast
                  return (
                    <AgentTaskToolsGroup
                      key={idx}
                      parts={part.parts}
                      chatStatus={status}
                      isStreaming={isGroupStreaming}
                      conversationId={conversationId}
                    />
                  )
                }
                return renderPart(part, idx, false)
              })
            })()}
          </CollapsibleSteps>
        )}

        {(() => {
          // Apply both grouping functions: first task tools, then exploring tools
          const taskGrouped = groupTaskTools(finalParts, nestedToolIds)
          const grouped = groupExploringTools(taskGrouped, nestedToolIds)
          return grouped.map((part: any, idx: number) => {
            if (part.type === "exploring-group") {
              const isLast = idx === grouped.length - 1
              const isGroupStreaming = isStreaming && isLastMessage && isLast
              return (
                <AgentExploringGroup
                  key={idx}
                  parts={part.parts}
                  chatStatus={status}
                  isStreaming={isGroupStreaming}
                />
              )
            }
            if (part.type === "task-group") {
              const isLast = idx === grouped.length - 1
              const isGroupStreaming = isStreaming && isLastMessage && isLast
              return (
                <AgentTaskToolsGroup
                  key={idx}
                  parts={part.parts}
                  chatStatus={status}
                  isStreaming={isGroupStreaming}
                  conversationId={conversationId}
                />
              )
            }
            return renderPart(part, shouldCollapse ? collapseBeforeIndex + idx : idx, shouldCollapse)
          })
        })()}

        {/* Show plan card after finalParts if any plan operation was in collapsed steps */}
        {shouldCollapse && lastCollapsedPlanOp && (
          <AgentPlanFileTool
            part={lastCollapsedPlanOp.part}
            chatStatus={status}
            conversationId={conversationId}
            isEdit={lastCollapsedPlanOp.type === "edit"}
          />
        )}

        {shouldShowPlanning && (
          <AgentToolCall
            icon={AgentToolRegistry["tool-planning"].icon}
            title={AgentToolRegistry["tool-planning"].title({})}
            isPending={true}
            isError={false}
          />
        )}

      </div>

      {showInterAgentReplies && (
        <div className="px-2">
          <InterAgentRepliesDisclosure message={message} chatId={chatId} />
        </div>
      )}

      {hasTextContent && (!isStreaming || !isLastMessage) && (
        <div className="flex justify-between items-center h-6 px-2 mt-1">
          <div className="flex items-center gap-0.5">
            <CopyButton
              text={getMessageTextContent(message)}
            />
          </div>
          <div className="flex items-center gap-0.5">
            <AgentMessageUsage metadata={msgMetadata} isStreaming={isStreaming} />
            {onFork && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    tabIndex={-1}
                    className="p-1 rounded-md transition-[background-color,transform] duration-150 ease-out hover:bg-accent active:scale-[0.97]"
                  >
                    <MoreHorizontal className="w-3.5 h-3.5 text-muted-foreground" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-[160px]">
                  <DropdownMenuItem onClick={() => onFork(message.id)}>
                    Fork from here
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>
      )}

      {/* Git activity badges - commit/PR pills */}
      {(!isStreaming || !isLastMessage) && <GitActivityBadges parts={messageParts} chatId={chatId} conversationId={conversationId} />}

      {isDev && showMessageJson && (
        <div className="px-2 mt-2">
          <MessageJsonDisplay message={message} label="Assistant" />
        </div>
      )}
    </div>
  )
})
