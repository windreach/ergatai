"use client"

import { memo, useMemo } from "react"
import type { UIMessage } from "@ai-sdk/react"
import { GroupAgentMessageHeader } from "../collaboration/group-agent-message-header"
import { MemoizedTextPart } from "./memoized-text-part"
import { CopyButton } from "../ui/message-action-buttons"
import { InterAgentRepliesDisclosure } from "./inter-agent-replies-disclosure"
import {
  CORE_AGENT_OPTIONS,
  getCoreAgentDisplayName,
  type CoreAgentId,
} from "../lib/agent-contract-api"

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
 * 后端数据库已扩展，新增结构化字段存储agent消息元数据：
 * - from_agent_id: 发送者agent ID
 * - from_agent_name: 发送者显示名称
 * - message_type: 消息类型 (request/response/broadcast)
 * - content: 实际消息内容（纯文本）
 *
 * 前端通过metadata直接读取这些字段，无需解析JSON。
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
        senderAgentId?: string
        senderAgentName?: string
        agentId?: string
        agentName?: string
        messageType?: string
        fromAgentId?: string
        fromAgentName?: string
        agentContent?: string
      }
    | undefined

  // 提取消息内容：优先使用结构化字段，回退到解析parts
  const textContent = useMemo(() => {
    // 优先使用新的结构化字段
    if (metadata?.agentContent) {
      return metadata.agentContent
    }

    // 回退：从parts提取原始文本
    const rawText = message.parts
      ?.filter((p: any) => p.type === "text")
      .map((p: any) => p.text)
      .join("\n") || ""

    // 尝试解析JSON（向后兼容旧数据）
    try {
      const parsed = JSON.parse(rawText)
      if (parsed && typeof parsed === "object" && "message" in parsed) {
        return parsed.message
      }
    } catch {
      // 不是JSON，返回原始文本
    }

    return rawText
  }, [metadata?.agentContent, message.parts])

  // 提取发送者名称：优先使用结构化字段
  const agentSenderName =
    metadata?.fromAgentName ??
    metadata?.senderAgentName ??
    metadata?.agentName ??
    metadata?.senderAgentId

  const showAgentSenderHeader =
    (message.role as string) === "agent" && Boolean(agentSenderName)

  // Check if this is a persisted chat (has chat_ prefix) — needed for InterAgentRepliesDisclosure
  const isPersistedChat = chatId.startsWith("chat_")

  // Use provided displaySenderName or fall back to metadata
  const finalSenderName =
    displaySenderName ?? (getCoreAgentDisplayName(agentSenderName) ?? agentSenderName)

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
