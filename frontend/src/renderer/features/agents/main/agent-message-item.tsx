"use client"

import { memo } from "react"
import type { UIMessage } from "@ai-sdk/react"
import { GroupAgentMessageHeader } from "../collaboration/group-agent-message-header"
import { MemoizedTextPart } from "./memoized-text-part"
import { CopyButton } from "../ui/message-action-buttons"
import { InterAgentRepliesDisclosure } from "./inter-agent-replies-disclosure"
import { CORE_AGENT_OPTIONS, type CoreAgentId } from "../lib/agent-contract-api"

interface AgentMessageItemProps {
  message: UIMessage<any>
  chatId: string
  isMobile: boolean
  displaySenderName?: string
  senderCoreAgentId?: CoreAgentId
}

/**
 * AgentMessageItem - Renders agent-sourced messages (role="agent")
 *
 * These are inter-agent requests (agent as sender), not replies.
 * Renders with agent header and text only (no tools/thinking).
 *
 * Used in both main chat (isolated-message-group) and side chat.
 */
export const AgentMessageItem = memo(function AgentMessageItem({
  message,
  chatId,
  isMobile,
  displaySenderName,
  senderCoreAgentId,
}: AgentMessageItemProps) {
  const messageId = message.id
  const metadata = message.metadata as
    | {
        source?: string
        senderAgentId?: string
        senderAgentName?: string
        agentId?: string
        agentName?: string
      }
    | undefined

  // Extract text content from message parts
  const textContent =
    message.parts
      ?.filter((p: any) => p.type === "text")
      .map((p: any) => p.text)
      .join("\n") || ""

  // Determine if we should show the agent sender header
  const agentSenderName =
    metadata?.senderAgentName ??
    metadata?.agentName ??
    metadata?.senderAgentId

  const showAgentSenderHeader =
    metadata?.source === "agent" && Boolean(agentSenderName)

  // Check if this is a persisted chat (has chat_ prefix) — needed for InterAgentRepliesDisclosure
  const isPersistedChat = chatId.startsWith("chat_")

  // Use provided displaySenderName or fall back to metadata
  const finalSenderName = displaySenderName ?? agentSenderName

  return (
    <div
      data-agent-message-id={messageId}
      className="group/message w-full mb-4"
    >
      {showAgentSenderHeader && finalSenderName && (
        <GroupAgentMessageHeader
          agentId={senderCoreAgentId ?? undefined}
          agentName={finalSenderName}
        />
      )}
      <div className="flex flex-col gap-1.5">
        {/* Only render text content - no tools or thinking process */}
        {textContent && (
          <MemoizedTextPart
            text={textContent}
            messageId={messageId}
            partIndex={0}
            isStreaming={false}
          />
        )}
      </div>
      {/* Bottom action bar - copy button */}
      {textContent && (
        <div className="flex justify-between items-center h-6 px-2 mt-1">
          <div className="flex items-center gap-0.5">
            <CopyButton
              text={textContent}
              isMobile={isMobile}
            />
          </div>
        </div>
      )}
      {isPersistedChat && (
        <div className="px-2">
          <InterAgentRepliesDisclosure message={message} chatId={chatId} />
        </div>
      )}
    </div>
  )
})
