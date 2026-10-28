"use client"

import { createContext, useContext, useMemo } from "react"
import { getFileIconByExtension } from "./file-icon-utils"
import { SkillIcon, CustomAgentIcon, OriginalMCPIcon } from "../../../components/ui/icons"
import { UnknownFileIcon } from "../../../icons/framework-icons"
// Import utilities from separate file for Fast Refresh compatibility
import { extractFileMentions, hasFileMentions, parseMention, extractTextMentions, type ParsedMention } from "./mentions-utils"

// Re-export for backward compatibility
export { extractFileMentions, hasFileMentions, extractTextMentions }
export type { ParsedMention }

/**
 * Context for opening files in the file viewer sidebar.
 * Provided by ChatView, consumed by MentionChip.
 */
type FileOpenHandler = (filePath: string) => void
const FileOpenContext = createContext<FileOpenHandler | null>(null)

export function FileOpenProvider({
  onOpenFile,
  children,
}: {
  onOpenFile: FileOpenHandler
  children: React.ReactNode
}) {
  return (
    <FileOpenContext.Provider value={onOpenFile}>
      {children}
    </FileOpenContext.Provider>
  )
}

/**
 * Hook to access the file open handler from any child component.
 * Returns null if not inside a FileOpenProvider.
 */
export function useFileOpen(): FileOpenHandler | null {
  return useContext(FileOpenContext)
}

// Text selection icon - "A" with text cursor
function TextSelectIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <path fillRule="evenodd" clipRule="evenodd" d="M8.50027 4C8.91147 4 9.28067 4.25166 9.43107 4.63435L14.9311 18.6343C15.133 19.1484 14.88 19.7288 14.366 19.9308C13.8519 20.1327 13.2715 19.8797 13.0695 19.3657L11.3545 15H5.64607L3.93107 19.3657C3.72907 19.8797 3.14867 20.1327 2.63462 19.9308C2.12058 19.7288 1.86757 19.1484 2.06952 18.6343L7.56947 4.63435C7.71987 4.25166 8.08907 4 8.50027 4ZM6.43177 13H10.5688L8.50027 7.73484L6.43177 13Z" fill="currentColor"/>
      <path d="M17 2C16.4477 2 16 2.44772 16 3C16 3.55228 16.4477 4 17 4H18V20H17C16.4477 20 16 20.4477 16 21C16 21.5523 16.4477 22 17 22H21C21.5523 22 22 21.5523 22 21C22 20.4477 21.5523 20 21 20H20V4H21C21.5523 4 22 3.55228 22 3C22 2.44772 21.5523 2 21 2H17Z" fill="currentColor"/>
    </svg>
  )
}

// Code selection icon - cursor arrow with text cursor
function CodeSelectIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <path d="M14 2C13.4477 2 13 2.44772 13 3C13 3.55228 13.4477 4 14 4H15V20H14C13.4477 20 13 20.4477 13 21C13 21.5523 13.4477 22 14 22H18C18.5523 22 19 21.5523 19 21C19 20.4477 18.5523 20 18 20H17V4H18C18.5523 4 19 3.55228 19 3C19 2.44772 18.5523 2 18 2H14Z" fill="currentColor"/>
      <path d="M4.29287 5.29289C4.68338 4.90237 5.31638 4.90237 5.70698 5.29289L11.707 11.2929C12.0974 11.6834 12.0975 12.3165 11.707 12.707L5.70698 18.707C5.31648 19.0975 4.68338 19.0974 4.29287 18.707C3.90237 18.3164 3.90237 17.6834 4.29287 17.2929L9.58587 11.9999L4.29287 6.70696C3.90237 6.31643 3.90237 5.68342 4.29287 5.29289Z" fill="currentColor"/>
    </svg>
  )
}

// Chat history icon - message square
function ChatHistoryIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  )
}

// Closed folder icon (collapsed style)
function FolderClosedIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      className={className}
    >
      <path
        d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}


/**
 * Component to render a single file/folder/skill/agent/tool/quote/diff mention chip (matching canvas style)
 */
function MentionChip({ mention }: { mention: ParsedMention }) {
  const onOpenFile = useContext(FileOpenContext)

  // Quote and diff mentions render as block cards
  if (mention.type === "quote") {
    // Get a short title from the label
    const title = mention.label.split('\n')[0]?.slice(0, 20) || mention.label.slice(0, 20)
    const displayTitle = title.length < mention.label.length ? `${title}...` : title

    return (
      <span className="inline-flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-muted/50 cursor-default min-w-[120px] max-w-[200px] align-middle">
        {/* Icon container */}
        <span className="flex items-center justify-center size-8 rounded-md bg-muted shrink-0">
          <TextSelectIcon className="size-4 text-muted-foreground" />
        </span>
        {/* Text content */}
        <span className="flex flex-col min-w-0">
          <span className="text-sm font-medium text-foreground truncate">
            {displayTitle}
          </span>
          <span className="text-xs text-muted-foreground">
            Selected Text
          </span>
        </span>
      </span>
    )
  }

  if (mention.type === "diff") {
    const fileName = mention.path.split("/").pop() || mention.path

    return (
      <span className="inline-flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-muted/50 cursor-default min-w-[120px] max-w-[200px] align-middle">
        {/* Icon container */}
        <span className="flex items-center justify-center size-8 rounded-md bg-muted shrink-0">
          <CodeSelectIcon className="size-4 text-muted-foreground" />
        </span>
        {/* Text content */}
        <span className="flex flex-col min-w-0">
          <span className="text-sm font-medium text-foreground truncate">
            {fileName}
          </span>
          <span className="text-xs text-muted-foreground">
            {mention.lineNumber ? `Line ${mention.lineNumber}` : "Code selection"}
          </span>
        </span>
      </span>
    )
  }

  const isClickable = (mention.type === "file" || mention.type === "folder") && !!onOpenFile

  const getIcon = () => {
    if (mention.type === "skill") return SkillIcon
    if (mention.type === "agent") return CustomAgentIcon
    if (mention.type === "tool") return OriginalMCPIcon
    if (mention.type === "folder") return FolderClosedIcon
    return getFileIconByExtension(mention.label) ?? UnknownFileIcon
  }
  const Icon = getIcon()

  const getTitle = () => {
    if (mention.type === "skill") return `Skill: ${mention.label}`
    if (mention.type === "agent") return `Agent: ${mention.label}`
    if (mention.type === "tool") return `MCP Tool: ${mention.path}`
    return `${mention.repository}:${mention.path}`
  }
  const title = getTitle()

  return (
    <span
      className={`inline-flex items-center gap-1 px-[6px] rounded-[6px] text-sm align-middle bg-black/[0.04] dark:bg-white/[0.08] text-foreground/80 select-none${isClickable ? " cursor-pointer hover:bg-black/[0.08] dark:hover:bg-white/[0.12] transition-colors" : ""}`}
      title={title}
      onClick={isClickable ? () => onOpenFile(mention.path) : undefined}
    >
      <Icon className={mention.type === "tool" ? "h-3.5 w-3.5 text-muted-foreground flex-shrink-0" : "h-3 w-3 text-muted-foreground flex-shrink-0"} />
      <span>{mention.label}</span>
    </span>
  )
}

/**
 * Render text with ultrathink highlighting
 */
function renderTextWithUltrathink(text: string): React.ReactNode {
  const parts = text.split(/(ultrathink)/gi)
  if (parts.length === 1) return text

  return parts.map((part, index) => {
    if (part.toLowerCase() === "ultrathink") {
      return (
        <span key={index} className="chroma-text chroma-text-animate">
          {part}
        </span>
      )
    }
    return part
  })
}

/**
 * Hook to render text with file/folder mentions and ultrathink highlighting
 * Returns array of React nodes with mentions rendered as chips
 */
export function useRenderFileMentions(text: string): React.ReactNode[] {
  return useMemo(() => {
    const nodes: React.ReactNode[] = []
    const regex = /@\[([^\]]+)\]/g
    let lastIndex = 0
    let match: RegExpExecArray | null
    let key = 0

    while ((match = regex.exec(text)) !== null) {
      // Add text before mention (with ultrathink highlighting)
      if (match.index > lastIndex) {
        nodes.push(
          <span key={`text-${key++}`}>
            {renderTextWithUltrathink(text.slice(lastIndex, match.index))}
          </span>,
        )
      }

      const id = match[1]
      const mention = parseMention(id)

      if (mention) {
        nodes.push(<MentionChip key={`mention-${key++}`} mention={mention} />)
      } else {
        // Fallback: show as plain text if not a valid mention
        nodes.push(<span key={`unknown-${key++}`}>{match[0]}</span>)
      }

      lastIndex = match.index + match[0].length
    }

    // Add remaining text (with ultrathink highlighting)
    if (lastIndex < text.length) {
      nodes.push(
        <span key={`text-end-${key}`}>
          {renderTextWithUltrathink(text.slice(lastIndex))}
        </span>
      )
    }

    return nodes
  }, [text])
}

/**
 * Component to render text with file mentions
 */
export function RenderFileMentions({
  text,
  className,
}: {
  text: string
  className?: string
}) {
  const nodes = useRenderFileMentions(text)
  return <span className={className}>{nodes}</span>
}

/**
 * Format bytes to human readable size
 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  return `${(kb / 1024).toFixed(1)} MB`
}

/**
 * Component to render a single text mention block (file/folder/quote/diff/pasted)
 * Used for displaying above message bubbles, not inline
 */
export function TextMentionBlock({ mention }: { mention: ParsedMention }) {
  const onOpenFile = useContext(FileOpenContext)

  if (mention.type !== "file" && mention.type !== "quote" && mention.type !== "diff" && mention.type !== "pasted" && mention.type !== "chatHistory" && mention.type !== "folder") return null

  // File mentions render in the upload-card style: icon block on the left,
  // file name on the right (same look as uploaded file attachments)
  if (mention.type === "file") {
    const FileIcon = getFileIconByExtension(mention.label) ?? UnknownFileIcon
    const isClickable = !!onOpenFile

    return (
      <div
        className={`flex items-center gap-2 pl-1 pr-2 py-1 rounded-lg bg-muted/50 min-w-[120px] max-w-[200px]${isClickable ? " cursor-pointer hover:bg-muted transition-colors" : " cursor-default"}`}
        title={`${mention.repository}:${mention.path}`}
        onClick={isClickable ? () => onOpenFile?.(mention.path) : undefined}
      >
        <div className="flex items-center justify-center w-8 self-stretch rounded-md bg-muted shrink-0">
          <FileIcon className="size-4 text-muted-foreground" />
        </div>
        <div className="flex flex-col min-w-0">
          <span className="text-sm font-medium text-foreground truncate">
            {mention.label}
          </span>
          <span className="text-xs text-muted-foreground truncate">
            {mention.path}
          </span>
        </div>
      </div>
    )
  }

  // Folder mentions render in the upload-card style: icon block on the left,
  // folder name on the right (same look as uploaded file attachments)
  if (mention.type === "folder") {
    return (
      <div className="flex items-center gap-2 pl-1 pr-2 py-1 rounded-lg bg-muted/50 cursor-default min-w-[120px] max-w-[200px]">
        <div className="flex items-center justify-center w-8 self-stretch rounded-md bg-muted shrink-0">
          <FolderClosedIcon className="size-4 text-muted-foreground" />
        </div>
        <div className="flex flex-col min-w-0">
          <span className="text-sm font-medium text-foreground truncate">
            {mention.label}
          </span>
          <span className="text-xs text-muted-foreground">
            Folder
          </span>
        </div>
      </div>
    )
  }

  const getDisplayTitle = () => {
    if (mention.type === "chatHistory") {
      return mention.label?.trim() || "Previous Chat"
    }
    if (mention.type === "quote" || mention.type === "pasted") {
      return mention.label.split('\n')[0]?.slice(0, 20) || mention.label.slice(0, 20)
    }
    return mention.path?.split("/").pop() || "Code"
  }
  const displayTitle = getDisplayTitle()

  const title = displayTitle.length < 20 ? displayTitle : `${displayTitle}...`

  const getSubtitle = () => {
    if (mention.type === "chatHistory") return "Past chat"
    if (mention.type === "quote") return "Selected Text"
    if (mention.type === "pasted") return `Pasted Text · ${formatSize(mention.size || 0)}`
    if (mention.lineNumber) return `Line ${mention.lineNumber}`
    return "Code selection"
  }
  const subtitle = getSubtitle()

  const getIcon = () => {
    if (mention.type === "chatHistory") {
      return <ChatHistoryIcon className="size-4 text-muted-foreground" />
    }
    if (mention.type === "quote" || mention.type === "pasted") {
      return <TextSelectIcon className="size-4 text-muted-foreground" />
    }
    return <CodeSelectIcon className="size-4 text-muted-foreground" />
  }
  const icon = getIcon()

  return (
    <div className="flex items-center gap-2 pl-1 pr-2 py-1 rounded-lg bg-muted/50 cursor-default min-w-[120px] max-w-[200px]">
      <div className="flex items-center justify-center w-8 self-stretch rounded-md bg-muted shrink-0">
        {icon}
      </div>
      <div className="flex flex-col min-w-0">
        <span className="text-sm font-medium text-foreground truncate">
          {title}
        </span>
        <span className="text-xs text-muted-foreground">
          {subtitle}
        </span>
      </div>
    </div>
  )
}

/**
 * Component to render multiple text mention blocks
 */
export function TextMentionBlocks({ mentions }: { mentions: ParsedMention[] }) {
  const textMentions = mentions.filter(m => m.type === "file" || m.type === "quote" || m.type === "diff" || m.type === "pasted" || m.type === "chatHistory" || m.type === "folder")
  if (textMentions.length === 0) return null

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {textMentions.map((mention, idx) => (
        <TextMentionBlock key={idx} mention={mention} />
      ))}
    </div>
  )
}
