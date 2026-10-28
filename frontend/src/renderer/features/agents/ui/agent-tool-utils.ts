/**
 * Utility functions for agent tool components
 *
 * CRITICAL: AI SDK mutates objects in-place during streaming!
 * This means prev.output === next.output (same reference) even when
 * the values inside have changed. We MUST cache state externally
 * and compare cached values, not object references.
 */

// ============================================================================
// TOOL STATE CACHE
// ============================================================================
// Cache for cleanup purposes. The actual comparison is now done via pure
// comparison in hasToolStateChanged without side effects.
// ============================================================================

const toolStateCache = new Map<string, any>()

export function clearToolStateCachesByToolCallIds(toolCallIds: string[]) {
  for (const toolCallId of toolCallIds) {
    toolStateCache.delete(toolCallId)
  }
}

function hasToolStateChanged(prev: any, next: any): boolean {
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

  return false
}

/**
 * Compare two part objects by their significant fields.
 * Returns true if they are equal.
 *
 * IMPORTANT: Uses pure comparison without side effects.
 */
function arePartsEqual(prev: any, next: any): boolean {
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
function isToolCompleted(part: any): boolean {
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
  prevProps: { part: any; chatStatus?: string },
  nextProps: { part: any; chatStatus?: string },
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
  prevProps: { part: any; nestedTools: any[]; chatStatus?: string },
  nextProps: { part: any; nestedTools: any[]; chatStatus?: string },
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
  prevProps: { parts: any[]; chatStatus?: string; isStreaming: boolean },
  nextProps: { parts: any[]; chatStatus?: string; isStreaming: boolean },
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
    input: any
    result?: any
    errorText?: string
    state: string
    isError?: boolean
    isStreaming?: boolean
    toolCallId?: string
  },
  nextProps: {
    input: any
    result?: any
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
