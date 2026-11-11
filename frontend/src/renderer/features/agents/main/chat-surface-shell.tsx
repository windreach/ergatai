"use client"

import { type ReactNode } from "react"
import { cn } from "@/lib/utils"

/**
 * ChatSurfaceShell
 *
 * Shared layout shell for both main and side conversations. It standardizes the
 * vertical composition (title -> banners -> messages -> footer) so that mode-
 * specific UI (title editor, diff/plan/terminal sidebars, quick comments,
 * status cards, input areas) can be injected as slots instead of duplicating
 * the whole chat tree.
 *
 * Phase B: slots only; rendering of messages/input stays owned by callers via
 * `messagesSlot` / `footerSlot` to avoid forcing a single renderer.
 */
export interface ChatSurfaceShellProps {
  /** Optional title row (main chat title editor, etc.). */
  titleSlot?: ReactNode
  /** Banners / quick-comment inputs rendered above the message list. */
  beforeMessagesSlot?: ReactNode
  /** The message list (ActiveChatMessages / ChatMessagesRenderer). */
  messagesSlot: ReactNode
  /** Content rendered below messages, above the footer (e.g. permission panel). */
  afterMessagesSlot?: ReactNode
  /** Footer: status cards + input area + queue. */
  footerSlot?: ReactNode
  className?: string
  /** When true, the shell fills its parent (default true). */
  fill?: boolean
}

export function ChatSurfaceShell({
  titleSlot,
  beforeMessagesSlot,
  messagesSlot,
  afterMessagesSlot,
  footerSlot,
  className,
  fill = true,
}: ChatSurfaceShellProps) {
  return (
    <div className={cn("flex flex-col min-h-0", fill && "flex-1", className)}>
      {titleSlot ? <div className="flex-shrink-0">{titleSlot}</div> : null}
      {beforeMessagesSlot ? <div className="flex-shrink-0">{beforeMessagesSlot}</div> : null}
      <div className="flex flex-1 min-h-0 flex-col overflow-hidden">
        {messagesSlot}
      </div>
      {afterMessagesSlot ? <div className="flex-shrink-0">{afterMessagesSlot}</div> : null}
      {footerSlot ? <div className="flex-shrink-0">{footerSlot}</div> : null}
    </div>
  )
}
