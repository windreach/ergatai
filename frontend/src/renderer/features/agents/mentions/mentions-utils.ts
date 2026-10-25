/**
 * Utility functions for extracting file mentions from text.
 * Separated from render-file-mentions.tsx to maintain Fast Refresh compatibility.
 */

import { MENTION_PREFIXES } from "./agents-mentions-editor"

interface ParsedMention {
  id: string
  label: string
  path: string
  repository: string
  type: "file" | "folder" | "skill" | "agent" | "tool" | "quote" | "diff" | "pasted" | "chatHistory"
  // Extra data for quote/diff/pasted mentions
  fullText?: string
  lineNumber?: number
  size?: number // Size in bytes for pasted mentions
}

/**
 * Parse file/folder/skill/agent/tool/quote/diff/pasted mention ID into its components
 * Format: file:owner/repo:path/to/file.tsx or folder:owner/repo:path/to/folder or skill:skill-name or agent:agent-name or tool:servername
 * Quote format: quote:preview_text:full_text (base64 encoded full text)
 * Diff format: diff:filepath:lineNumber:preview_text:full_text (base64 encoded full text)
 * Pasted format: pasted:size:preview|filepath
 * ChatHistory format: chatHistory:size:preview|filepath
 */
export function parseMention(id: string): ParsedMention | null {
  const isFile = id.startsWith(MENTION_PREFIXES.FILE)
  const isFolder = id.startsWith(MENTION_PREFIXES.FOLDER)
  const isSkill = id.startsWith(MENTION_PREFIXES.SKILL)
  const isAgent = id.startsWith(MENTION_PREFIXES.AGENT)
  const isTool = id.startsWith(MENTION_PREFIXES.TOOL)
  const isQuote = id.startsWith(MENTION_PREFIXES.QUOTE)
  const isDiff = id.startsWith(MENTION_PREFIXES.DIFF)
  const isPasted = id.startsWith(MENTION_PREFIXES.PASTED)
  const isChatHistory = id.startsWith(MENTION_PREFIXES.CHAT_HISTORY)

  if (!isFile && !isFolder && !isSkill && !isAgent && !isTool && !isQuote && !isDiff && !isPasted && !isChatHistory) return null

  // Handle quote mentions (format: quote:preview_text:base64_full_text)
  if (isQuote) {
    const content = id.slice(MENTION_PREFIXES.QUOTE.length)
    const separatorIdx = content.indexOf(":")
    if (separatorIdx === -1) {
      // Simple format without full text
      return {
        id,
        label: content.slice(0, 50) + (content.length > 50 ? "..." : ""),
        path: "",
        repository: "",
        type: "quote",
        fullText: content,
      }
    }
    const preview = content.slice(0, separatorIdx)
    const encodedText = content.slice(separatorIdx + 1)
    let fullText = preview
    try {
      // UTF-8 safe base64 decoding
      const binString = atob(encodedText)
      const bytes = Uint8Array.from(binString, (char) => char.codePointAt(0)!)
      fullText = new TextDecoder().decode(bytes)
    } catch {
      fullText = preview
    }
    return {
      id,
      label: preview,
      path: "",
      repository: "",
      type: "quote",
      fullText,
    }
  }

  // Handle diff mentions (format: diff:filepath:lineNumber:preview_text:base64_full_text)
  if (isDiff) {
    const content = id.slice(MENTION_PREFIXES.DIFF.length)
    const parts = content.split(":")
    if (parts.length < 3) return null

    const filePath = parts[0] || ""
    const lineNumber = parseInt(parts[1] || "0", 10) || undefined
    const preview = parts[2] || ""
    const encodedText = parts.slice(3).join(":") // Handle colons in base64

    let fullText = preview
    try {
      if (encodedText) {
        // UTF-8 safe base64 decoding
        const binString = atob(encodedText)
        const bytes = Uint8Array.from(binString, (char) => char.codePointAt(0)!)
        fullText = new TextDecoder().decode(bytes)
      }
    } catch {
      fullText = preview
    }

    const fileName = filePath.split("/").pop() || filePath
    const lineInfo = lineNumber ? `:${lineNumber}` : ""

    return {
      id,
      label: `${fileName}${lineInfo}`,
      path: filePath,
      repository: "",
      type: "diff",
      fullText,
      lineNumber,
    }
  }

  // Handle pasted mentions (format: pasted:size:preview|filepath)
  // Using | as separator between preview and filepath since filepath can contain colons
  if (isPasted) {
    const content = id.slice(MENTION_PREFIXES.PASTED.length)
    const pipeIndex = content.lastIndexOf("|")
    if (pipeIndex === -1) return null

    const beforePipe = content.slice(0, pipeIndex)
    const filePath = content.slice(pipeIndex + 1)

    const colonIndex = beforePipe.indexOf(":")
    if (colonIndex === -1) return null

    const size = parseInt(beforePipe.slice(0, colonIndex) || "0", 10)
    const preview = beforePipe.slice(colonIndex + 1)

    return {
      id,
      label: preview,
      path: filePath,
      repository: "",
      type: "pasted",
      size,
    }
  }

  // Handle chat history mentions (same format as pasted: chatHistory:size:preview|filepath)
  if (isChatHistory) {
    const content = id.slice(MENTION_PREFIXES.CHAT_HISTORY.length)
    const pipeIndex = content.lastIndexOf("|")
    if (pipeIndex === -1) return null

    const beforePipe = content.slice(0, pipeIndex)
    const filePath = content.slice(pipeIndex + 1)

    const colonIndex = beforePipe.indexOf(":")
    if (colonIndex === -1) return null

    const size = parseInt(beforePipe.slice(0, colonIndex) || "0", 10)
    const preview = beforePipe.slice(colonIndex + 1)

    return {
      id,
      label: preview,
      path: filePath,
      repository: "",
      type: "chatHistory",
      size,
    }
  }

  // Handle skill mentions (simpler format: skill:name)
  if (isSkill) {
    const skillName = id.slice(MENTION_PREFIXES.SKILL.length)
    return {
      id,
      label: skillName,
      path: "",
      repository: "",
      type: "skill",
    }
  }

  // Handle agent mentions (simpler format: agent:name)
  if (isAgent) {
    const agentName = id.slice(MENTION_PREFIXES.AGENT.length)
    return {
      id,
      label: agentName,
      path: "",
      repository: "",
      type: "agent",
    }
  }

  // Handle tool mentions: tool:servername (MCP server) or tool:mcp__server__toolname (individual tool)
  if (isTool) {
    const toolPath = id.slice(MENTION_PREFIXES.TOOL.length)
    if (toolPath.startsWith("mcp__")) {
      const parts = toolPath.split("__")
      const toolName = parts.length >= 3 ? parts.slice(2).join("__") : toolPath
      const displayName = toolName
        .replace(/_/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase())
        .trim()
      return {
        id,
        label: displayName,
        path: toolPath,
        repository: "",
        type: "tool",
      }
    }
    return {
      id,
      label: toolPath,
      path: toolPath,
      repository: "",
      type: "tool",
    }
  }

  const parts = id.split(":")
  if (parts.length < 3) return null

  const type = parts[0] as "file" | "folder"
  const repository = parts[1]
  const path = parts.slice(2).join(":") // Handle paths with colons
  const name = path.split("/").pop() || path

  return {
    id,
    label: name,
    path,
    repository,
    type,
  }
}

/**
 * Extract all file/folder mention IDs from text
 * Returns array of raw mention IDs (not parsed)
 */
export function extractFileMentionIds(text: string): string[] {
  const ids: string[] = []
  const regex = /@\[([^\]]+)\]/g
  let match: RegExpExecArray | null

  while ((match = regex.exec(text)) !== null) {
    ids.push(match[1])
  }

  return ids
}

/**
 * Extract all file/folder mentions from text
 * Returns array of parsed mentions
 */
export function extractFileMentions(text: string): ParsedMention[] {
  const mentions: ParsedMention[] = []
  const regex = /@\[([^\]]+)\]/g
  let match: RegExpExecArray | null

  while ((match = regex.exec(text)) !== null) {
    const mention = parseMention(match[1])
    if (mention) {
      mentions.push(mention)
    }
  }

  return mentions
}

/**
 * Check if text contains any file, folder, skill, agent, tool, quote, diff, or pasted mentions
 */
export function hasFileMentions(text: string): boolean {
  return /@\[(file|folder|skill|agent|tool|quote|diff|pasted|chatHistory):[^\]]+\]/.test(text)
}

/**
 * Extract file/folder/quote/diff/pasted mentions from text and return them separately with cleaned text
 * Used for rendering these mentions as blocks above the message bubble
 */
export function extractTextMentions(text: string): {
  textMentions: ParsedMention[]
  cleanedText: string
} {
  const textMentions: ParsedMention[] = []
  let cleanedText = text

  const regex = /@\[([^\]]+)\]/g
  let match: RegExpExecArray | null
  const mentionsToRemove: string[] = []

  while ((match = regex.exec(text)) !== null) {
    const id = match[1]
    if (
      id.startsWith(MENTION_PREFIXES.FILE) ||
      id.startsWith(MENTION_PREFIXES.QUOTE) ||
      id.startsWith(MENTION_PREFIXES.DIFF) ||
      id.startsWith(MENTION_PREFIXES.PASTED) ||
      id.startsWith(MENTION_PREFIXES.CHAT_HISTORY) ||
      id.startsWith(MENTION_PREFIXES.FOLDER)
    ) {
      const parsed = parseMention(id)
      if (parsed) {
        textMentions.push(parsed)
        mentionsToRemove.push(match[0])
      }
    }
  }

  // Remove the mentions from text
  for (const mentionStr of mentionsToRemove) {
    cleanedText = cleanedText.replace(mentionStr, "")
  }

  // Clean up extra whitespace but preserve newlines
  // Only collapse multiple spaces (not newlines) into one space
  // and trim leading/trailing whitespace from each line
  cleanedText = cleanedText
    .split("\n")
    .map(line => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n") // Collapse 3+ newlines to 2
    .trim()

  return { textMentions, cleanedText }
}

export type { ParsedMention }
