"use client"

import { memo } from "react"
import { useAtomValue } from "jotai"
import { AtSign, CheckCircle2, Loader2, XCircle } from "lucide-react"

import { cn } from "../../../lib/utils"
import { getCoreAgentIcon } from "../components/core-agent-selector"
import {
  resolveAgentRuntimeId,
  type CoreAgentId,
} from "../lib/agent-contract-api"
import { registeredAgentsAtom } from "../atoms"

import {
  getSendMessageArgs,
} from "../lib/ergatai-mcp-detection"

const AGENT_DISPLAY_NAMES: Record<string, string> = {
  "claude-code": "Claude Code",
  "codex": "Codex",
  "opencode": "OpenCode",
}

interface GroupAgentMentionToolProps {
  part: {
    toolCallId: string
    input?: {
      target_agent_id?: string
      message?: string
      message_type?: string
    }
    output?: unknown
    result?: string
    errorText?: string
    state?: string
  }
  senderAgentId?: string
  senderAgentName?: string
}

// react-doctor-disable-next-line no-high-complexity-react-function
export const GroupAgentMentionTool = memo(function GroupAgentMentionTool({
  part,
  senderAgentId,
  senderAgentName,
}: GroupAgentMentionToolProps) {
  const registeredAgents = useAtomValue(registeredAgentsAtom)
  const sendArgs = getSendMessageArgs(part)
  const targetAgentId = sendArgs?.target_agent_id as CoreAgentId | undefined
  const message = sendArgs?.message ?? ""
  const messageType = sendArgs?.message_type ?? "request"
  const isPending = !part.output && !part.errorText
  const isError = !!part.errorText

  const senderRuntimeId =
    resolveAgentRuntimeId(
      registeredAgents,
      senderAgentId,
      senderAgentName,
    ) ?? undefined
  const targetRuntimeId =
    resolveAgentRuntimeId(registeredAgents, targetAgentId) ?? undefined
  const SenderIcon = senderAgentId
    ? getCoreAgentIcon(senderAgentId as CoreAgentId, senderRuntimeId)
    : null
  const TargetIcon = targetAgentId
    ? getCoreAgentIcon(targetAgentId, targetRuntimeId)
    : AtSign

  const targetName = targetAgentId
    ? (AGENT_DISPLAY_NAMES[targetAgentId] ?? targetAgentId)
    : "Unknown Agent"

  return (
    <div
      className={cn(
        "group/mention flex items-start gap-2 rounded-lg border px-3 py-2 text-xs",
        isError
          ? "border-destructive/30 bg-destructive/5"
          : isPending
            ? "border-amber-500/30 bg-amber-500/5"
            : "border-emerald-500/30 bg-emerald-500/5",
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <div className="flex items-center gap-1.5 shrink-0">
          {SenderIcon && <SenderIcon className="h-3.5 w-3.5 text-muted-foreground" />}
          {senderAgentName && (
            <span className="text-muted-foreground">{senderAgentName}</span>
          )}
          <AtSign className="h-3 w-3 text-muted-foreground/60" />
          <TargetIcon className="h-3.5 w-3.5 text-foreground" />
          <span className="font-medium text-foreground">{targetName}</span>
        </div>

        {message && (
          <span className="min-w-0 truncate text-muted-foreground">
            {message}
          </span>
        )}
      </div>

      <div className="flex items-center gap-1 shrink-0">
        <span
          className={cn(
            "rounded-full px-1.5 py-0.5 text-[10px] font-medium",
            messageType === "request"
              ? "bg-blue-500/15 text-blue-600 dark:text-blue-400"
              : messageType === "response"
                ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                : "bg-muted text-muted-foreground",
          )}
        >
          {messageType}
        </span>
        {isPending ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-500" />
        ) : isError ? (
          <XCircle className="h-3.5 w-3.5 text-destructive" />
        ) : (
          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
        )}
      </div>
    </div>
  )
})