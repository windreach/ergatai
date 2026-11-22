// Modified from 1Code (Apache-2.0) by Ergatai — see MODIFICATIONS.md
/**
 * Utility functions for agent tool components
 *
 * CRITICAL: AI SDK mutates objects in-place during streaming!
 * This means prev.output === next.output (same reference) even when
 * the values inside have changed. We MUST cache state externally
 * and compare cached values, not object references.
 */

// Looser type for comparison functions - accepts unknown part-like object
// This allows component-specific part types to be passed without casting
type ComparablePart = {
  type: string
  toolCallId?: string
  state?: string
  input?: unknown
  output?: unknown
  error?: unknown
  errorText?: unknown
}

// ============================================================================
// TOOL STATE CACHE
// ============================================================================
// Cache for cleanup purposes. The actual comparison is now done via pure
// comparison in hasToolStateChanged without side effects.
// ============================================================================

import { BoundedCache } from "../../../lib/bounded-cache"

const toolStateCache = new BoundedCache<string, unknown>(1000)

export function clearToolStateCachesByToolCallIds(toolCallIds: string[]) {
  for (const toolCallId of toolCallIds) {
    toolStateCache.delete(toolCallId)
  }
}

function hasToolStateChanged(prev: ComparablePart, next: ComparablePart): boolean {
  // Pure comparison - no side effects
  // Compare state, input, and output directly
  if (prev.state !== next.state) return true

  // Deep compare input using JSON.stringify
  const prevInputJson = JSON.stringify(prev.input || {})
  const nextInputJson = JSON.stringify(next.input || {})
  if (prevInputJson !== nextInputJson) return true

  // Deep compare output using JSON.stringify
  const prevOutputJson = JSON.stringify(prev.output || {})
  const nextOutputJson = JSON.stringify(next.output || {})
  if (prevOutputJson !== nextOutputJson) return true

  // Failure messages arrive separately from state on some backends
  const prevErrorJson = JSON.stringify(prev.error ?? prev.errorText ?? null)
  const nextErrorJson = JSON.stringify(next.error ?? next.errorText ?? null)
  if (prevErrorJson !== nextErrorJson) return true

  return false
}

/**
 * Compare two part objects by their significant fields.
 * Returns true if they are equal.
 *
 * IMPORTANT: Uses pure comparison without side effects.
 */
function arePartsEqual(prev: ComparablePart, next: ComparablePart): boolean {
  // Different toolCallId = different tool
  if (prev.toolCallId !== next.toolCallId) return false
  if (prev.type !== next.type) return false

  // Use pure comparison for the next part
  const toolCallId = next.toolCallId
  if (!toolCallId) {
    // No toolCallId - fall back to simple comparison
    return prev.state === next.state
  }

  // Check if tool state has changed using pure comparison
  const changed = hasToolStateChanged(prev, next)

  // Return true (equal) if nothing changed
  return !changed
}

/**
 * Check if a tool is completed (has output or error state).
 * Completed tools don't need to react to chatStatus changes.
 */
function isToolCompleted(part: ComparablePart): boolean {
  // Has output = completed
  if (part.output !== undefined && part.output !== null) return true
  // Error state = completed
  if (part.state === "error") return true
  // Result state = completed (for some tools)
  if (part.state === "result") return true
  return false
}

/**
 * Deep compare function for tool part props.
 * Used with React.memo() to prevent unnecessary re-renders when
 * parent component re-renders but the tool's actual data hasn't changed.
 *
 * This is critical for streaming performance - when ai-sdk updates messages,
 * it creates new object references for all parts, but most parts haven't
 * actually changed. This comparator checks the actual values.
 *
 * OPTIMIZATION: Completed tools don't re-render on chatStatus changes.
 */
export function areToolPropsEqual(
  prevProps: { part: ComparablePart; chatStatus?: string },
  nextProps: { part: ComparablePart; chatStatus?: string },
): boolean {
  // First check if the tool data itself changed
  const partsEqual = arePartsEqual(prevProps.part, nextProps.part)

  if (!partsEqual) return false

  // If tool is completed, it doesn't care about chatStatus changes
  if (isToolCompleted(nextProps.part)) {
    return true
  }

  // For pending tools, chatStatus matters (determines spinner vs completed)
  if (prevProps.chatStatus !== nextProps.chatStatus) return false

  return true
}

/**
 * Compare function for AgentTaskTool which has additional nestedTools prop.
 */
export function areTaskToolPropsEqual(
  prevProps: { part: ComparablePart; nestedTools: ComparablePart[]; chatStatus?: string },
  nextProps: { part: ComparablePart; nestedTools: ComparablePart[]; chatStatus?: string },
): boolean {
  // Compare main part first
  if (!arePartsEqual(prevProps.part, nextProps.part)) return false

  // Compare nestedTools array
  const prevNested = prevProps.nestedTools || []
  const nextNested = nextProps.nestedTools || []

  if (prevNested.length !== nextNested.length) return false

  // Compare each nested tool
  for (let i = 0; i < prevNested.length; i++) {
    if (!arePartsEqual(prevNested[i], nextNested[i])) return false
  }

  // If all tools are completed, don't care about chatStatus
  const mainCompleted = isToolCompleted(nextProps.part)
  const allNestedCompleted = nextNested.every(isToolCompleted)

  if (mainCompleted && allNestedCompleted) {
    return true
  }

  // For pending tools, chatStatus matters
  if (prevProps.chatStatus !== nextProps.chatStatus) return false

  return true
}

/**
 * Compare function for AgentExploringGroup which has parts array.
 */
export function areExploringGroupPropsEqual(
  prevProps: { parts: ComparablePart[]; chatStatus?: string; isStreaming: boolean },
  nextProps: { parts: ComparablePart[]; chatStatus?: string; isStreaming: boolean },
): boolean {
  const prevParts = prevProps.parts || []
  const nextParts = nextProps.parts || []

  if (prevParts.length !== nextParts.length) return false

  for (let i = 0; i < prevParts.length; i++) {
    if (!arePartsEqual(prevParts[i], nextParts[i])) return false
  }

  // isStreaming changes always matter - they drive auto-collapse via useEffect
  if (prevProps.isStreaming !== nextProps.isStreaming) return false

  // If all parts are completed, don't care about chatStatus
  const allCompleted = nextParts.every(isToolCompleted)
  if (allCompleted) {
    return true
  }

  // For pending groups, chatStatus matters
  if (prevProps.chatStatus !== nextProps.chatStatus) return false

  return true
}

type ToolFileInput = {
  _locations?: Array<{ path?: string }>
  file_path?: unknown
  filePath?: unknown
  path?: unknown
  file?: unknown
}

/**
 * Resolve the file path a tool part operates on.
 *
 * Backend/persisted parts do not always carry `_locations` — an agent may
 * only report `input.path` (e.g. `{ "path": "/tmp/HelloWorld.java" }`).
 * Falling back to the raw input fields keeps rendering and step counting
 * consistent before and after the live projection is replaced by the
 * persisted copy.
 *
 * Keep in sync with the backend's `resolve_tool_file_path`.
 */
export function getToolFilePath(part: {
  input?: unknown
  locations?: Array<{ path?: string }> | null
} | null | undefined): string {
  const input = part?.input as ToolFileInput | undefined

  const inputLocationPath = input?._locations?.[0]?.path
  if (typeof inputLocationPath === "string" && inputLocationPath.length > 0) {
    return inputLocationPath
  }

  // Persisted ACP parts carry `locations` next to `input` rather than nested
  // under `input._locations`.
  const topLevelLocationPath = part?.locations?.[0]?.path
  if (typeof topLevelLocationPath === "string" && topLevelLocationPath.length > 0) {
    return topLevelLocationPath
  }

  if (!input) return ""

  for (const candidate of [input.file_path, input.filePath, input.path, input.file]) {
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate
    }
  }

  return ""
}

/**
 * Resolve a possibly workspace-relative path against the chat's workspace root.
 *
 * Some agents report `path` relative to their session cwd. The backend file
 * read API resolves relative paths against the server process cwd, which is
 * wrong for desktop chats. Callers that know the workspace root should resolve
 * before fetching.
 */
export function resolveWorkspaceRelativePath(
  filePath: string,
  workspacePath?: string | null,
): string {
  if (!filePath) return filePath
  if (filePath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(filePath)) return filePath
  if (!workspacePath) return filePath
  const base = workspacePath.replace(/[\\/]+$/, "")
  return `${base}/${filePath.replace(/^\.\//, "")}`
}

/**
 * Resolve a human-readable failure message for a tool part.
 *
 * Live parts carry `error`, persisted/projected parts may carry `errorText`,
 * and some backends embed the reason in `output`/`result`.
 */
export function getToolErrorText(
  part: { error?: unknown; errorText?: unknown; output?: unknown; result?: unknown } | null | undefined,
): string {
  if (!part) return ""
  return (
    extractTextValue(part.errorText) ||
    extractTextValue(part.error) ||
    extractTextValue(part.output) ||
    extractTextValue(part.result)
  )
}

function extractTextValue(value: unknown, depth = 0): string {
  if (value == null || depth > 4) return ""
  if (typeof value === "string") return value.trim()
  if (typeof value !== "object") return ""

  if (Array.isArray(value)) {
    return value
      .map((item) => extractTextValue(item, depth + 1))
      .filter(Boolean)
      .join("\n")
  }

  const record = value as Record<string, unknown>
  for (const key of [
    "errorText",
    "error_message",
    "errorMessage",
    "error",
    "message",
    "stderr",
    "stdout",
    "output",
    "content",
    "text",
  ]) {
    const text = extractTextValue(record[key], depth + 1)
    if (text) return text
  }
  return ""
}

/**
 * Check if a file path is a plan file.
 * Plan files are stored in the claude-sessions directory under /plans/
 */
export function isPlanFile(filePath: string): boolean {
  // Check for official plan location in claude-sessions
  if (filePath.includes("claude-sessions") && filePath.includes("/plans/")) {
    return true
  }
  // Also check for plan files by name pattern (for backwards compatibility)
  const fileName = filePath.split("/").pop()?.toLowerCase() || ""
  if (fileName.includes("plan") && fileName.endsWith(".md")) {
    return true
  }
  return false
}

/**
 * Compare function for AgentAskUserQuestionTool which has different props structure.
 * Uses pure comparison without side effects.
 */

export function areAskUserQuestionPropsEqual(
  prevProps: {
    input: {
      questions?: Array<{
        question: string
        header: string
        options: Array<{ label: string; description: string }>
        multiSelect: boolean
      }>
    }
    result?:
      | {
          answers?: Record<string, string>
        }
      | string
    errorText?: string
    state: string
    isError?: boolean
    isStreaming?: boolean
    toolCallId?: string
  },
  nextProps: {
    input: {
      questions?: Array<{
        question: string
        header: string
        options: Array<{ label: string; description: string }>
        multiSelect: boolean
      }>
    }
    result?:
      | {
          answers?: Record<string, string>
        }
      | string
    errorText?: string
    state: string
    isError?: boolean
    isStreaming?: boolean
    toolCallId?: string
  },
): boolean {
  // Different toolCallId = different tool
  if (prevProps.toolCallId !== nextProps.toolCallId) return false

  const toolCallId = nextProps.toolCallId
  if (!toolCallId) {
    // No toolCallId - fall back to simple comparison
    return prevProps.state === nextProps.state
  }

  // Pure comparison - no side effects
  const stateChanged = prevProps.state !== nextProps.state
  const isErrorChanged = prevProps.isError !== nextProps.isError
  const errorTextChanged = prevProps.errorText !== nextProps.errorText
  const inputChanged = JSON.stringify(prevProps.input || {}) !== JSON.stringify(nextProps.input || {})
  const resultChanged = JSON.stringify(prevProps.result || {}) !== JSON.stringify(nextProps.result || {})

  const changed = stateChanged || isErrorChanged || errorTextChanged || inputChanged || resultChanged

  if (changed) {
    return false
  }

  // If tool has result, it's completed - don't care about isStreaming
  if (nextProps.result !== undefined) {
    return true
  }

  // For pending state, isStreaming matters
  if (prevProps.isStreaming !== nextProps.isStreaming) return false

  return true
}
