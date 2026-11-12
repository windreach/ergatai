/**
 * Mention tokens (e.g. `@[file:local:src/app.ts]`) are a UI serialization
 * detail. They must never leak into generated conversation titles, so these
 * helpers convert them into short, human-readable text.
 */

const MENTION_TOKEN_PATTERN = /@\[((?:[^\]\\]|\\.)+)\]/g

function basename(path: string): string {
  const normalized = path.replace(/\\/g, "/")
  return normalized.split("/").filter(Boolean).pop() ?? normalized
}

/**
 * Convert mention tokens in arbitrary prompt text to readable text without
 * truncating the result.
 *
 * - file / folder / diff mentions become the affected file name
 * - agent mentions keep their `@name` form
 * - skill / command mentions keep their `/name` form
 * - quote / pasted / chat history mentions use their short preview
 * - tool / plugin and unknown tokens are dropped
 */
export function mentionsToReadableText(text: string): string {
  const readable = text.replace(
    MENTION_TOKEN_PATTERN,
    (_token: string, id: string) => {
      const parts = id.split(":")
      const type = parts[0]

      switch (type) {
        case "file":
        case "folder": {
          // file:local:path/to/file.ts or folder:owner/repo:path/to/folder
          const path = parts.slice(2).join(":")
          return path ? basename(path) : ""
        }
        case "diff": {
          // diff:filePath:lineNumber:preview:encodedText
          const path = parts[1] ?? ""
          const file = path ? basename(path) : ""
          const line = parts[2]
          return file && line ? `${file}:${line}` : file
        }
        case "agent":
          return parts.length > 1 ? `@${parts.slice(1).join(":")}` : ""
        case "skill":
        case "command":
          return parts.length > 1 ? `/${parts.slice(1).join(":")}` : ""
        case "quote":
          // quote:preview:encodedText
          return parts[1] ?? ""
        case "pasted":
        case "chatHistory": {
          // pasted:size:preview|filePath
          const preview = parts[2] ?? ""
          return preview.split("|")[0] ?? ""
        }
        case "tool":
        case "plugin":
        default:
          return ""
      }
    },
  )

  // Collapse whitespace (including newlines) so titles stay on one line.
  return readable.replace(/\s+/g, " ").trim()
}

/**
 * Build a one-line conversation title from the raw prompt text.
 */
export function promptToTitle(text: string, maxLength = 50): string {
  return mentionsToReadableText(text).slice(0, maxLength).trim()
}
