import type { Message, MessagePart, MessageRole } from "../stores/message-store"
import { MessageRolePolicy } from "../stores/message-store"
import type { SearchMatch } from "./chat-search-atoms"

// ============================================================================
// TEXT EXTRACTION
// ============================================================================

interface ExtractedText {
  messageId: string
  partIndex: number
  partType: string
  text: string
}

/**
 * Extract all searchable text from a message part
 * NOTE: Currently only searches text parts for simplicity.
 * Tool content search was removed to avoid complexity with highlighting.
 */
function extractTextFromPart(
  messageId: string,
  partIndex: number,
  part: MessagePart
): ExtractedText[] {
  const results: ExtractedText[] = []

  // Only search text parts - tool content search is disabled for now
  if (part.type === "text" && part.text && typeof part.text === "string" && part.text.trim()) {
    results.push({ messageId, partIndex, partType: "text", text: part.text })
  }

  return results
}

/**
 * Extract all searchable text from messages
 * Currently only extracts from text parts (tool content search disabled)
 */
export function extractSearchableText(messages: Message[]): ExtractedText[] {
  const results: ExtractedText[] = []

  for (const message of messages) {
    if (!message.parts) continue

    // For initiator messages (user/agent), consolidate all text parts into one entry with partIndex 0
    // This matches how initiator messages are rendered (single bubble with all text joined)
    if (MessageRolePolicy.isInitiator(message.role)) {
      const textParts = message.parts.filter(
        (p): p is MessagePart & { type: "text"; text: string } =>
          p.type === "text" && typeof p.text === "string" && p.text.trim().length > 0
      )
      if (textParts.length > 0) {
        const combinedText = textParts.map((p) => p.text).join("\n")
        results.push({
          messageId: message.id,
          partIndex: 0, // Always 0 for user messages
          partType: "text",
          text: combinedText,
        })
      }
      continue
    }

    // For assistant messages, extract from all parts (text and tools)
    for (let partIndex = 0; partIndex < message.parts.length; partIndex++) {
      const part = message.parts[partIndex]
      const extracted = extractTextFromPart(message.id, partIndex, part)
      results.push(...extracted)
    }
  }

  return results
}

// ============================================================================
// SEARCH ALGORITHM
// ============================================================================

/**
 * Find all matches for a query in extracted texts
 */
export function findMatches(
  extractedTexts: ExtractedText[],
  query: string
): SearchMatch[] {
  if (!query.trim()) return []

  const matches: SearchMatch[] = []
  const lowerQuery = query.toLowerCase()

  for (const extracted of extractedTexts) {
    const lowerText = extracted.text.toLowerCase()
    let searchStart = 0

    while (true) {
      const index = lowerText.indexOf(lowerQuery, searchStart)
      if (index === -1) break

      const matchId = `${extracted.messageId}:${extracted.partIndex}:${extracted.partType}:${index}`

      matches.push({
        id: matchId,
        messageId: extracted.messageId,
        partIndex: extracted.partIndex,
        partType: extracted.partType,
        offset: index,
        length: query.length,
      })

      searchStart = index + 1
    }
  }

  return matches
}

// ============================================================================
// HIGHLIGHT UTILITIES
// ============================================================================

export interface TextSegment {
  text: string
  isHighlight: boolean
  isCurrent: boolean
}

/**
 * Split text into segments based on highlight ranges
 */
export function splitTextByHighlights(
  text: string,
  highlights: Array<{ offset: number; length: number; isCurrent: boolean }>
): TextSegment[] {
  if (highlights.length === 0) {
    return [{ text, isHighlight: false, isCurrent: false }]
  }

  // Sort highlights by offset
  const sorted = [...highlights].sort((a, b) => a.offset - b.offset)

  const result: TextSegment[] = []
  let cursor = 0

  for (const h of sorted) {
    // Skip invalid highlights
    if (h.offset < cursor || h.offset >= text.length) continue

    // Text before highlight
    if (h.offset > cursor) {
      result.push({
        text: text.slice(cursor, h.offset),
        isHighlight: false,
        isCurrent: false,
      })
    }

    // Highlighted text
    const endOffset = Math.min(h.offset + h.length, text.length)
    result.push({
      text: text.slice(h.offset, endOffset),
      isHighlight: true,
      isCurrent: h.isCurrent,
    })

    cursor = endOffset
  }

  // Remaining text after last highlight
  if (cursor < text.length) {
    result.push({
      text: text.slice(cursor),
      isHighlight: false,
      isCurrent: false,
    })
  }

  return result
}

// ============================================================================
// DEBOUNCE UTILITY
// ============================================================================

export function debounce<T extends (...args: unknown[]) => unknown>(
  fn: T,
  delay: number
): T & { cancel: () => void } {
  let timeoutId: ReturnType<typeof setTimeout> | null = null

  const debounced = ((...args: Parameters<T>) => {
    if (timeoutId) {
      clearTimeout(timeoutId)
    }
    timeoutId = setTimeout(() => {
      fn(...args)
      timeoutId = null
    }, delay)
  }) as T & { cancel: () => void }

  debounced.cancel = () => {
    if (timeoutId) {
      clearTimeout(timeoutId)
      timeoutId = null
    }
  }

  return debounced
}
