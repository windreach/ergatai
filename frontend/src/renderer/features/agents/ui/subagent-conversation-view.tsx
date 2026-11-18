import i18n from "@/lib/i18n"
"use client"

import { useEffect, useRef } from "react"
import { ChatMarkdownRenderer } from "../../../components/chat-markdown-renderer"
import { cn } from "../../../lib/utils"
import {
  toSubagentRenderMessages,
  useSubagentMessages,
  useSubagentRuns,
} from "../lib/subagent-message-store"

interface SubagentConversationViewProps {
  agentId: string | null
  subagentSessionId: string | null
  className?: string
  onBack?: () => void
}

export function SubagentConversationView({
  agentId,
  subagentSessionId,
  className,
  onBack,
}: SubagentConversationViewProps) {
  const runs = useSubagentRuns(agentId)
  const messages = useSubagentMessages(agentId, subagentSessionId)
  const renderMessages = subagentSessionId
    ? toSubagentRenderMessages(subagentSessionId, messages)
    : []
  const run = runs.find((item) => item.subagentSessionId === subagentSessionId)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const node = scrollRef.current
    if (!node) return
    node.scrollTop = node.scrollHeight
  }, [messages.length, messages])

  if (!subagentSessionId) {
    return (
      <div className={cn("flex h-full items-center justify-center text-xs text-muted-foreground", className)}>
        Select a subagent
      </div>
    )
  }

  const renderMessage = renderMessages[0]

  return (
    <div className={cn("flex h-full flex-col", className)}>
      <div className="border-b border-border/40 pb-2">
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs font-medium text-foreground">
            {run?.name ?? subagentSessionId}
          </div>
          {onBack ? (
            <button
              type="button"
              onClick={onBack}
              className="text-[11px] text-muted-foreground hover:text-foreground"
            >
              Back to main conversation
            </button>
          ) : null}
        </div>
        {run?.task ? (
          <div className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">
            {run.task}
          </div>
        ) : null}
        {run?.state ? (
          <div className="mt-1 text-[11px] text-muted-foreground">
            State: {run.state}
          </div>
        ) : null}
      </div>

      <div ref={scrollRef} className="mt-2 flex-1 overflow-y-auto space-y-3 pr-1">
        {!renderMessage || renderMessage.parts.length === 0 ? (
          <div className="text-xs text-muted-foreground">{i18n.t('No messages yet')}</div>
        ) : (
          renderMessage.parts.map((part, index) => {
            if (part.type === "text") {
              return (
                // react-doctor-disable-next-line no-array-index-as-key
                <div key={`text-${index}`} className="text-xs">
                  <ChatMarkdownRenderer content={part.text} size="sm" />
                </div>
              )
            }

            if (part.type === "reasoning") {
              return (
                // react-doctor-disable-next-line no-array-index-as-key
                <div
                  key={`reasoning-${index}`}
                  className="rounded-md border border-border/40 bg-muted/30 px-2 py-1 text-[11px] text-muted-foreground"
                >
                  <div className="mb-1 font-medium">{i18n.t('Thinking')}</div>
                  <ChatMarkdownRenderer content={part.text} size="sm" />
                </div>
              )
            }

            return (
              // react-doctor-disable-next-line no-array-index-as-key
              <div
                key={`tool-${part.toolCall.toolCallId}-${index}`}
                className="rounded-md border border-border/40 bg-muted/20 px-2 py-1 text-[11px]"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-foreground">
                    {part.toolCall.toolName}
                  </span>
                  <span className="text-muted-foreground">
                    {part.toolCall.state}
                  </span>
                </div>
                <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words text-[10px] text-muted-foreground">
                  {JSON.stringify(part.toolCall.input ?? {}, null, 2)}
                </pre>
                {part.toolCall.output != null ? (
                  <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words text-[10px] text-muted-foreground">
                    {typeof part.toolCall.output === "string"
                      ? part.toolCall.output
                      : JSON.stringify(part.toolCall.output, null, 2)}
                  </pre>
                ) : null}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}