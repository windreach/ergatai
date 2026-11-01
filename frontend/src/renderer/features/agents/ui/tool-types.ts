"use client"

/**
 * Tool result type definitions for agent tool components.
 * These types provide type safety for tool output rendering.
 */

// ============================================================================
// Bash Tool
// ============================================================================
export interface BashToolOutput {
  stdout?: string
  stderr?: string
  output?: string // Alternative field name for stdout
  exitCode?: number | string
  exit_code?: number | string // Alternative field name
  truncated?: boolean
}

// ============================================================================
// Edit Tool
// ============================================================================
export interface EditToolOutput {
  content?: string
  structuredPatch?: {
    oldFileName?: string
    newFileName?: string
    hunks?: Array<{
      oldStart?: number
      oldLines?: number
      newStart?: number
      newLines?: number
      lines?: string[]
    }>
  }
  split?: Array<{
    type: "context" | "insert" | "delete"
    content?: string
  }>
  filePath?: string
  oldContent?: string
  newContent?: string
}

// ============================================================================
// Grep Tool
// ============================================================================
export interface GrepToolOutput {
  mode?: "content" | "files" | "count"
  numFiles?: number
  numLines?: number
  filenames?: string[]
  results?: Array<{
    file?: string
    line?: number
    content?: string
  }>
}

// ============================================================================
// Task Tool (Agent/Task spawning)
// ============================================================================
export interface TaskToolOutput {
  custom?: {
    description?: string
    status?: string
    result?: string
  }
  totalDurationMs?: number
  duration?: number
  duration_ms?: number
  taskId?: string
  agentId?: string
  result?: string
  status?: string
}

// ============================================================================
// Web Fetch Tool
// ============================================================================
export interface WebFetchToolOutput {
  result?: string
  bytes?: number
  code?: number
  url?: string
  contentType?: string
  error?: string
}

// ============================================================================
// Web Search Tool
// ============================================================================
export interface WebSearchToolOutput {
  results?: Array<{
    title?: string
    url?: string
    snippet?: string
    content?: string
  }>
  query?: string
  count?: number
}

// ============================================================================
// Generic Tool Output (fallback)
// ============================================================================
export type ToolOutput =
  | BashToolOutput
  | EditToolOutput
  | GrepToolOutput
  | TaskToolOutput
  | WebFetchToolOutput
  | WebSearchToolOutput
  | Record<string, unknown>

/**
 * Type guard to check if output is a specific tool type
 */
export function isBashToolOutput(output: unknown): output is BashToolOutput {
  return (
    typeof output === "object" &&
    output !== null &&
    ("stdout" in output || "stderr" in output || "exitCode" in output || "exit_code" in output)
  )
}

export function isEditToolOutput(output: unknown): output is EditToolOutput {
  return (
    typeof output === "object" &&
    output !== null &&
    ("content" in output || "structuredPatch" in output)
  )
}

export function isGrepToolOutput(output: unknown): output is GrepToolOutput {
  return (
    typeof output === "object" &&
    output !== null &&
    ("mode" in output || "numFiles" in output || "filenames" in output)
  )
}
