import { cn } from "../../../lib/utils"

/**
 * Conditional className overlay for A-to-A message variants.
 *
 * - `request`:   inbound prompt from another agent — starts a new conversation
 *                turn, so it needs to feel "primary".
 * - `response`:  reply / FYI appended to the previous turn — subdued.
 * - `broadcast`: one-way notification — banner-like, dashed border.
 * - `undefined`: stream-persisted assistant message (agents.rs Done event) —
 *                no override, render as today.
 *
 * All classes are drawn from existing Tailwind tokens used elsewhere in the
 * agents UI (muted / primary / border / text-muted-foreground). No new
 * palette colors are introduced.
 */
export function messageTypeVariantClass(
  messageType: "request" | "response" | "broadcast" | undefined,
): string | undefined {
  switch (messageType) {
    case "request":
      // Echoes Inter-AgentRepliesDisclosure trigger + AgentUserMessageBubble.
      return cn(
        "border-l-4 border-primary/60 bg-primary/5",
        "px-3 py-2 rounded-md",
      )
    case "response":
      // Subdued: same tokens as secondary text in GroupAgentMessageHeader.
      return "opacity-80 text-muted-foreground"
    case "broadcast":
      // Banner-like: echoes Inter-AgentRepliesDisclosure content area.
      return cn(
        "bg-muted/40 border border-dashed border-border/60",
        "px-3 py-2 rounded-md",
      )
    default:
      return undefined
  }
}
