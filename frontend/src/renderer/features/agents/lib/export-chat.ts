import { trpcClient } from "../../../lib/trpc"
import { toast } from "sonner"

const MAX_HISTORY_CHARS = 50_000

/**
 * Format chat messages as concise markdown for attaching as context to a new conversation.
 * Tool calls are summarized as one-liners. Truncates at ~50k chars, dropping oldest first.
 */
export function formatHistoryForContext(
  messages: Array<{ role: string; parts?: Array<{ type: string; text?: string; toolName?: string; result?: any; args?: any }> }>,
): string {
  const formatted: string[] = []

  for (const msg of messages) {
    const role = msg.role === "user" ? "User" : msg.role === "assistant" ? "Assistant" : msg.role === "agent" ? "Agent" : msg.role
    const lines: string[] = []

    for (const part of msg.parts || []) {
      if (part.type === "text" && part.text) {
        lines.push(part.text)
      } else if (part.type === "tool-call" || part.type?.startsWith("tool-")) {
        const toolName = part.toolName || part.type.replace("tool-", "")
        if (part.type === "tool-call") {
          lines.push(`[Tool call: ${toolName}]`)
        }
      }
    }

    if (lines.length > 0) {
      formatted.push(`**${role}:** ${lines.join("\n")}`)
    }
  }

  let result = "# Previous Chat History\n\n" + formatted.join("\n\n")

  // Truncate from the beginning if too long, keeping most recent context
  if (result.length > MAX_HISTORY_CHARS) {
    const truncated = result.slice(result.length - MAX_HISTORY_CHARS)
    const firstNewline = truncated.indexOf("\n\n")
    result =
      "# Previous Chat History (truncated)\n\n[...earlier messages omitted...]\n\n" +
      (firstNewline >= 0 ? truncated.slice(firstNewline + 2) : truncated)
  }

  return result
}

export type ExportFormat = "markdown" | "json" | "text"

interface ExportOptions {
  chatId: string
  conversationId?: string
  format: ExportFormat
  isRemote?: boolean
}

interface Message {
  role: string
  content: string | Array<{ type: string; text?: string }>
}

/**
 * Format messages for export
 */
function formatMessages(messages: Message[], format: ExportFormat, chatName: string): { content: string; filename: string } {
  const timestamp = new Date().toISOString().split('T')[0]
  const safeName = chatName.replace(/[^a-z0-9]/gi, '-').toLowerCase()

  if (format === "json") {
    return {
      content: JSON.stringify(messages, null, 2),
      filename: `${safeName}-${timestamp}.json`,
    }
  }

  const formattedMessages = messages.map((msg) => {
    const role = msg.role === "user" ? "User" : msg.role === "assistant" ? "Assistant" : msg.role === "agent" ? "Agent" : msg.role
    let content = ""

    if (typeof msg.content === "string") {
      content = msg.content
    } else if (Array.isArray(msg.content)) {
      content = msg.content
        .filter((part) => part.type === "text" && part.text)
        .map((part) => part.text)
        .join("\n")
    }

    if (format === "markdown") {
      return `## ${role}\n\n${content}`
    } else {
      return `${role}:\n${content}`
    }
  })

  const ext = format === "markdown" ? "md" : "txt"
  const separator = format === "markdown" ? "\n\n---\n\n" : "\n\n"

  return {
    content: formattedMessages.join(separator),
    filename: `${safeName}-${timestamp}.${ext}`,
  }
}

/**
 * Export a chat or conversation to a file.
 * Shows download dialog to save the exported content.
 */
export async function exportChat({ chatId, conversationId, format }: ExportOptions): Promise<void> {
  try {
    const exportData = await trpcClient.chats.exportChat.query({
      chatId,
      conversationId,
      format,
    })

    const blob = new Blob([exportData.content], { type: "text/plain;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = exportData.filename
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)

    toast.success("Export complete", {
      description: `Saved as ${exportData.filename}`,
    })
  } catch (error) {
    console.error("[exportChat] Error:", error)
    toast.error("Export failed", {
      description: error instanceof Error ? error.message : "Unable to export chat",
    })
  }
}

/**
 * Copy chat or conversation content to clipboard.
 */
export async function copyChat({ chatId, conversationId, format }: ExportOptions): Promise<void> {
  try {
    const exportData = await trpcClient.chats.exportChat.query({
      chatId,
      conversationId,
      format,
    })

    try {
      await navigator.clipboard.writeText(exportData.content)
    } catch {
      // Fallback using Electron clipboard API
      if (window.desktopApi?.clipboardWrite) {
        await window.desktopApi.clipboardWrite(exportData.content)
      } else {
        throw new Error("Clipboard not available")
      }
    }

    toast.success("Copied to clipboard")
  } catch (error) {
    console.error("[copyChat] Error:", error)
    toast.error("Copy failed", {
      description: error instanceof Error ? error.message : "Unable to copy chat",
    })
  }
}
