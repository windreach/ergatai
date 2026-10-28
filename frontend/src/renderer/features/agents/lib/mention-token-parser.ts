import type { SelectedTextContext, DiffTextContext, PastedTextFile } from "../types"
import { createTextPreview } from "./queue-utils"
import { base64ToUtf8 } from "../utils/base64"

/**
 * Result of parsing mention tokens from message text
 */
export interface ParsedMentionTokens {
  /** Text contexts extracted from @[quote:...] tokens */
  textContexts: SelectedTextContext[]
  /** Diff text contexts extracted from @[diff:...] tokens */
  diffTextContexts: DiffTextContext[]
  /** Pasted text files extracted from @[pasted:...] tokens */
  pastedTexts: PastedTextFile[]
  /** Clean text with all mention tokens removed */
  cleanedText: string
}

/**
 * Parse mention tokens from message text to restore text contexts, diff contexts, and pasted texts.
 *
 * Mention tokens have the format: @[type:data]
 * - @[quote:preview:base64] - Text context with preview and base64-encoded full text
 * - @[diff:filePath:lineNumber:preview:base64] - Diff text context with file location
 * - @[pasted:size:preview|filePath] - Pasted text file with size and preview
 *
 * @param rawText - Text containing mention tokens
 * @returns Parsed mention tokens and cleaned text
 */
export function parseMentionTokensFromText(rawText: string): ParsedMentionTokens {
  const textContexts: SelectedTextContext[] = []
  const diffTextContexts: DiffTextContext[] = []
  const pastedTexts: PastedTextFile[] = []
  let cleanedText = rawText

  const mentionRegex = /@\[([^\]]+)\]/g
  let match: RegExpExecArray | null
  const mentionsToRemove: string[] = []

  while ((match = mentionRegex.exec(rawText)) !== null) {
    const id = match[1]

    if (id.startsWith("quote:")) {
      const content = id.slice("quote:".length)
      const sepIdx = content.indexOf(":")
      if (sepIdx !== -1) {
        const preview = content.slice(0, sepIdx)
        const encoded = content.slice(sepIdx + 1)
        let fullText = preview
        try {
          fullText = base64ToUtf8(encoded)
        } catch (error) {
          // Fallback to preview if base64 decoding fails
          console.warn("[parseMentionTokens] Failed to decode base64 for quote token, using preview:", error)
        }
        textContexts.push({
          id: `tc_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
          text: fullText,
          sourceMessageId: "",
          preview: createTextPreview(fullText),
          createdAt: new Date(),
        })
      }
      mentionsToRemove.push(match[0])
    } else if (id.startsWith("diff:")) {
      const content = id.slice("diff:".length)
      const parts = content.split(":")
      if (parts.length >= 3) {
        const filePath = parts[0] || ""
        const lineNumber = parseInt(parts[1] || "0", 10) || undefined
        const preview = parts[2] || ""
        const encoded = parts.slice(3).join(":")
        let fullText = preview
        try {
          if (encoded) fullText = base64ToUtf8(encoded)
        } catch (error) {
          // Fallback to preview if base64 decoding fails
          console.warn("[parseMentionTokens] Failed to decode base64 for diff token, using preview:", error)
        }
        diffTextContexts.push({
          id: `dtc_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
          text: fullText,
          filePath,
          lineNumber,
          preview: createTextPreview(fullText),
          createdAt: new Date(),
        })
      }
      mentionsToRemove.push(match[0])
    } else if (id.startsWith("pasted:")) {
      const content = id.slice("pasted:".length)
      const pipeIdx = content.lastIndexOf("|")
      if (pipeIdx !== -1) {
        const beforePipe = content.slice(0, pipeIdx)
        const filePath = content.slice(pipeIdx + 1)
        const colonIdx = beforePipe.indexOf(":")
        if (colonIdx !== -1) {
          const size = parseInt(beforePipe.slice(0, colonIdx) || "0", 10)
          const preview = beforePipe.slice(colonIdx + 1)
          pastedTexts.push({
            id: `pasted_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
            filePath,
            filename: filePath.split("/").pop() || "pasted.txt",
            size,
            preview,
            createdAt: new Date(),
          })
        }
      }
      mentionsToRemove.push(match[0])
    }
  }

  // Remove mention tokens from text to get clean user text
  for (const mentionStr of mentionsToRemove) {
    cleanedText = cleanedText.replaceAll(mentionStr, "")
  }
  cleanedText = cleanedText
    .replace(/\n{3,}/g, "\n\n")
    .trim()

  return {
    textContexts,
    diffTextContexts,
    pastedTexts,
    cleanedText,
  }
}
