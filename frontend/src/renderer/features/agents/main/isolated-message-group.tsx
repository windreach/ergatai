"use client"

import { createContext, memo, useCallback, useMemo } from "react"
import { useAtomValue } from "jotai"
import {
  getPerChatMessageKey,
  messageAtomFamily,
  assistantIdsPerChatAtomFamily,
  isLastUserMessagePerChatAtomFamily,
  rollbackTargetPerChatAtomFamily,
  isRollingBackAtom,
} from "../stores/message-store"
import { MemoizedAssistantMessages } from "./messages-list"
import { AgentMessageItem } from "./agent-message-item"
import { MemoizedTextPart } from "./memoized-text-part"
import { GroupAgentMessageHeader } from "../collaboration/group-agent-message-header"
import { InterAgentRepliesDisclosure } from "./inter-agent-replies-disclosure"
import {
  CORE_AGENT_OPTIONS,
  resolveCoreAgentId,
  type CoreAgentId,
} from "../lib/agent-contract-api"
import { trpc } from "../../../lib/trpc"
import { extractTextMentions, TextMentionBlocks, TextMentionBlock } from "../mentions/render-file-mentions"
import { AgentImageItem } from "../ui/agent-image-item"
import { IconTextUndo } from "../../../components/ui/icons"
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip"
import { cn } from "../../../lib/utils"
import { useStreamingStatusStore } from "../stores/streaming-status-store"
import { CopyButton } from "../ui/message-action-buttons"

// Context for fork callback - avoids threading props through MemoizedAssistantMessages
export const ForkContext = createContext<((messageId: string) => void) | null>(null)

// ============================================================================
// ISOLATED MESSAGE GROUP (LAYER 4)
// ============================================================================
// Renders ONE user message and its associated assistant messages.
// Subscribes to Jotai atoms for:
// - The specific user message
// - Assistant message IDs for this group
// - Whether this is the last user message
// - Streaming status
//
// Only re-renders when:
// - User message content changes (rare)
// - New assistant message is added to this group
// - This becomes/stops being the last group
// - Streaming starts/stops (for planning indicator)
// ============================================================================

interface IsolatedMessageGroupProps {
  userMsgId: string
  conversationId: string
  chatId: string
  isMobile: boolean
  sandboxSetupStatus: "cloning" | "ready" | "error"
  stickyTopClass: string
  sandboxSetupError?: string
  onRetrySetup?: () => void
  onRollback?: (msg: any) => void
  onFork?: (messageId: string) => void
  // Components passed from parent - must be stable references
  UserBubbleComponent: React.ComponentType<{
    messageId: string
    textContent: string
    imageParts: any[]
    skipTextMentionBlocks?: boolean
  }>
  ToolCallComponent: React.ComponentType<{
    icon: any
    title: string
    isPending: boolean
    isError: boolean
  }>
  MessageGroupWrapper: React.ComponentType<{ children: React.ReactNode; isLastGroup?: boolean }>
  toolRegistry: Record<string, { icon: any; title: (args: any) => string }>
}

function areGroupPropsEqual(
  prev: IsolatedMessageGroupProps,
  next: IsolatedMessageGroupProps
): boolean {
  return (
    prev.userMsgId === next.userMsgId &&
    prev.conversationId === next.conversationId &&
    prev.chatId === next.chatId &&
    prev.isMobile === next.isMobile &&
    prev.sandboxSetupStatus === next.sandboxSetupStatus &&
    prev.stickyTopClass === next.stickyTopClass &&
    prev.sandboxSetupError === next.sandboxSetupError &&
    prev.onRetrySetup === next.onRetrySetup &&
    prev.onRollback === next.onRollback &&
    prev.onFork === next.onFork &&
    prev.UserBubbleComponent === next.UserBubbleComponent &&
    prev.ToolCallComponent === next.ToolCallComponent &&
    prev.MessageGroupWrapper === next.MessageGroupWrapper &&
    prev.toolRegistry === next.toolRegistry
  )
}

export const IsolatedMessageGroup = memo(function IsolatedMessageGroup({
  userMsgId,
  conversationId,
  chatId,
  isMobile,
  sandboxSetupStatus,
  stickyTopClass,
  sandboxSetupError,
  onRetrySetup,
  onRollback,
  onFork,
  UserBubbleComponent,
  ToolCallComponent,
  MessageGroupWrapper,
  toolRegistry,
}: IsolatedMessageGroupProps) {
  // Subscribe to specific atoms - NOT the whole messages array
  const perChatKey = `${conversationId}:${userMsgId}`
  const userMsg = useAtomValue(messageAtomFamily(getPerChatMessageKey(conversationId, userMsgId)))
  const assistantIds = useAtomValue(assistantIdsPerChatAtomFamily(perChatKey))
  const isLastGroup = useAtomValue(isLastUserMessagePerChatAtomFamily(perChatKey))
  const rollbackTargetSdkUuid = useAtomValue(rollbackTargetPerChatAtomFamily(perChatKey))
  const conversationStatus = useStreamingStatusStore(
    useCallback((state) => state.statuses[conversationId] ?? "ready", [conversationId]),
  )
  const isStreaming = conversationStatus === "streaming" || conversationStatus === "submitted"
  const isRollingBack = useAtomValue(isRollingBackAtom)

  // Show rollback button only when this user turn has a valid rollback target.
  const canRollback = onRollback && !!rollbackTargetSdkUuid && !isStreaming
  const canFork = !!onFork

  // Extract user message content
  // Note: file-content parts are hidden from UI but sent to agent
  const rawTextContent =
    userMsg?.parts
      ?.filter((p: any) => p.type === "text")
      .map((p: any) => p.text)
      .join("\n") || ""

  const imageParts =
    userMsg?.parts?.filter((p: any) => p.type === "data-image") || []

  // Extract text mentions (quote/diff) to render separately above sticky block
  // NOTE: useMemo must be called before any early returns to follow Rules of Hooks
  const { textMentions, cleanedText: textContent } = useMemo(
    () => extractTextMentions(rawTextContent),
    [rawTextContent]
  )

  // Resolve auto-generated runtime sender ids (ws_…-agent-N) to a real
  // display name. The backend stamps the raw runtime agent id into message
  // metadata; without resolution the header would show it verbatim.
  const isPersistedChatForQueries = chatId.startsWith("chat_")
  const senderBindingsQuery = trpc.ergatai.getAgentBindings.useQuery(
    { chatId },
    { enabled: isPersistedChatForQueries },
  )
  const senderLiveAgentsQuery = trpc.ergatai.listAgents.useQuery(undefined, {
    enabled: isPersistedChatForQueries,
    refetchInterval: 5000,
  })

  if (!userMsg) return null

  // Determine if this is an agent-sourced message (should be rendered as user bubble with agent name)
  // or a user message (should be rendered as user bubble)
  const isAgentSourcedMessage = userMsg.role === "agent"

  // Check if this is a persisted chat (has chat_ prefix) — needed for InterAgentRepliesDisclosure
  const isPersistedChat = chatId.startsWith("chat_")

  // Show cloning when sandbox is being set up
  const shouldShowCloning =
    sandboxSetupStatus === "cloning" && isLastGroup && assistantIds.length === 0

  // Show setup error if sandbox setup failed
  const shouldShowSetupError =
    sandboxSetupStatus === "error" && isLastGroup && assistantIds.length === 0

  // Check if this is an image-only message (no text content and no text mentions)
  const isImageOnlyMessage = imageParts.length > 0 && !textContent.trim() && textMentions.length === 0

  // Check if this is an attachment-only message (no text but has images or text mentions)
  const isAttachmentOnlyMessage = !textContent.trim() && (imageParts.length > 0 || textMentions.length > 0)

  // Agent-sourced user turns (A-to-A requests persisted by the backend)
  // must show the real sender above the bubble — otherwise they are
  // indistinguishable from the human user's own messages in this pane.
  const userMsgMetadata = userMsg.metadata as
    | {
        source?: string
        senderAgentId?: string
        senderAgentName?: string
        agentId?: string
        agentName?: string
      }
    | undefined
  const agentSenderName =
    userMsgMetadata?.senderAgentName ??
    userMsgMetadata?.agentName ??
    userMsgMetadata?.senderAgentId
  const showAgentSenderHeader =
    userMsgMetadata?.source === "agent" && Boolean(agentSenderName)

  // Auto-generated runtime ids (ws_…-agent-N) carry no meaning for the user
  // — resolve them to the configured agent name: the live agent registry
  // first, then the chat's agent bindings (runtime agent id → configured
  // profile / core agent name).
  const runtimeSenderId = userMsgMetadata?.senderAgentId ?? userMsgMetadata?.agentId
  const looksAutoGenerated = (value?: string | null) =>
    !value ||
    value === runtimeSenderId ||
    value === userMsgMetadata?.senderAgentName ||
    /^ws[_-]/.test(value)
  const liveSender = runtimeSenderId
    ? senderLiveAgentsQuery.data?.find((agent) => agent.agent_id === runtimeSenderId)
    : undefined
  const senderBinding = runtimeSenderId
    ? senderBindingsQuery.data?.find((binding) => binding.agentId === runtimeSenderId)
    : undefined
  const coreNameFor = (raw?: string | null) => {
    if (!raw || looksAutoGenerated(raw)) return undefined
    const normalized = raw.toLowerCase()
    return CORE_AGENT_OPTIONS.find((option) =>
      [option.id, option.name, option.profileName, option.defaultCommand].some(
        (value) => value && normalized.includes(value.toLowerCase()),
      ),
    )?.name
  }
  const configuredSenderName =
    // The live agent's configured profile is the most specific name we have
    // (e.g. a custom registration like "aibrowser"); fall back to the core
    // agent display name derived from the profile / spawn command.
    (liveSender?.profile && !looksAutoGenerated(liveSender.profile)
      ? (coreNameFor(liveSender.profile) ?? liveSender.profile)
      : undefined) ??
    coreNameFor(senderBinding?.agentCommand) ??
    (senderBinding?.agentName && !looksAutoGenerated(senderBinding.agentName)
      ? senderBinding.agentName
      : undefined)
  const displaySenderName =
    agentSenderName && !looksAutoGenerated(agentSenderName)
      ? agentSenderName
      : (configuredSenderName ?? agentSenderName)

  // Resolve sender's CoreAgentId from metadata (avoid unsafe type assertion)
  const resolvedSenderAgentId = userMsgMetadata?.senderAgentId ?? userMsgMetadata?.agentId
  const senderCoreAgentId = resolvedSenderAgentId
    ? resolveCoreAgentId(
        resolvedSenderAgentId,
        agentSenderName,
        liveSender?.profile ?? undefined,
        senderBinding?.agentCommand ?? undefined,
      )
    : null

  return (
    <MessageGroupWrapper isLastGroup={isLastGroup}>
      {/* All attachments in one row - NOT sticky (only when there's also text) */}
      {((!isImageOnlyMessage && imageParts.length > 0) || textMentions.length > 0) && (
        <div className="mb-2 pointer-events-auto flex flex-wrap items-end gap-1.5">
          {imageParts.length > 0 && !isImageOnlyMessage && (() => {
            const resolveImgUrl = (img: any) =>
              img.data?.base64Data && img.data?.mediaType
                ? `data:${img.data.mediaType};base64,${img.data.base64Data}`
                : img.data?.url || ""
            const allImages = imageParts
              .filter((img: any) => img.data?.url || img.data?.base64Data)
              .map((img: any, idx: number) => ({
                id: `${userMsgId}-img-${idx}`,
                filename: img.data?.filename || "image",
                url: resolveImgUrl(img),
              }))
            return imageParts.map((img: any, idx: number) => (
              <AgentImageItem
                key={`${userMsgId}-img-${idx}`}
                id={`${userMsgId}-img-${idx}`}
                filename={img.data?.filename || "image"}
                url={resolveImgUrl(img)}
                allImages={allImages}
                imageIndex={idx}
              />
            ))
          })()}
          {textMentions.map((mention, idx) => (
            <TextMentionBlock key={`mention-${idx}`} mention={mention} />
          ))}
        </div>
      )}

      {/* User message text (or attachment-only summary bubble) */}
      <div
        data-user-message-id={userMsgId}
        className={`group/user-message [&>div]:!mb-4 pointer-events-auto z-10 ${stickyTopClass}`}
      >
        {/* Show "Using X" summary when no text but have attachments */}
        <div className="relative">
          {isAttachmentOnlyMessage && !isImageOnlyMessage ? (
            <div className="flex justify-end drop-shadow-[0_10px_20px_hsl(var(--background))]" data-user-bubble>
              <div className="w-fit max-w-[85%] space-y-2">
                <div className="w-fit bg-muted px-3 py-2 rounded-xl text-sm text-muted-foreground italic">
                {(() => {
                  const parts: string[] = []
                  if (imageParts.length > 0) {
                    parts.push(imageParts.length === 1 ? "image" : `${imageParts.length} images`)
                  }
                  const quoteCount = textMentions.filter(m => m.type === "quote").length
                  const pastedCount = textMentions.filter(m => m.type === "pasted").length
                  const codeCount = textMentions.filter(m => m.type === "diff").length
                  if (quoteCount > 0) {
                    parts.push(quoteCount === 1 ? "selected text" : `${quoteCount} text selections`)
                  }
                  if (pastedCount > 0) {
                    parts.push(pastedCount === 1 ? "pasted text" : `${pastedCount} pasted texts`)
                  }
                  if (codeCount > 0) {
                    parts.push(codeCount === 1 ? "code selection" : `${codeCount} code selections`)
                  }
                  return `Using ${parts.join(", ")}`
                })()}
                </div>
              </div>
            </div>
          ) : isAgentSourcedMessage ? (
            // Agent-sourced messages (role: "agent") are inter-agent requests
            // Render with agent header, not as user bubble
            <AgentMessageItem
              message={userMsg as any}
              chatId={chatId}
              isMobile={isMobile}
              displaySenderName={displaySenderName}
              senderCoreAgentId={senderCoreAgentId ?? undefined}
            />
          ) : (
            <UserBubbleComponent
              messageId={userMsgId}
              textContent={textContent}
              imageParts={isImageOnlyMessage ? imageParts : []}
              skipTextMentionBlocks={!isImageOnlyMessage}
            />
          )}

          {/* Rollback button - overlay bottom-right of user bubble */}
          {canRollback && (
            <div className="absolute bottom-1 right-1 z-20 flex items-center gap-0.5">
              {canRollback && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => onRollback(userMsg)}
                      disabled={isRollingBack}
                      tabIndex={-1}
                      className={cn(
                        "p-1 rounded-md transition-all duration-150 ease-out hover:bg-accent/80 active:scale-[0.97] opacity-0 group-hover/user-message:opacity-100",
                        isRollingBack && "!opacity-50 cursor-not-allowed",
                      )}
                    >
                      <IconTextUndo className="w-3.5 h-3.5 text-muted-foreground" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {isRollingBack ? "Rolling back..." : "Rollback to here"}
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
          )}
        </div>

        {/* Cloning indicator */}
        {shouldShowCloning && (
          <div className="mt-4">
            <ToolCallComponent
              icon={toolRegistry["tool-cloning"]?.icon}
              title={toolRegistry["tool-cloning"]?.title({}) || "Cloning..."}
              isPending={true}
              isError={false}
            />
          </div>
        )}

        {/* Setup error with retry */}
        {shouldShowSetupError && (
          <div className="mt-4 p-3 bg-destructive/10 border border-destructive/20 rounded-lg">
            <div className="flex items-center gap-2 text-destructive text-sm">
              <span>
                Failed to set up sandbox
                {sandboxSetupError ? `: ${sandboxSetupError}` : ""}
              </span>
              {onRetrySetup && (
                <button
                  className="px-2 py-1 text-sm hover:bg-destructive/20 rounded"
                  onClick={onRetrySetup}
                >
                  Retry
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Assistant messages - memoized, only re-renders when IDs change */}
      {assistantIds.length > 0 && (
        <ForkContext.Provider value={canFork ? onFork : null}>
          <MemoizedAssistantMessages
            assistantMsgIds={assistantIds}
            conversationId={conversationId}
            chatId={chatId}
            isMobile={isMobile}
            sandboxSetupStatus={sandboxSetupStatus}
          />
        </ForkContext.Provider>
      )}

      {/* Planning indicator */}
      {isStreaming &&
        isLastGroup &&
        assistantIds.length === 0 &&
        sandboxSetupStatus === "ready" && (
          <div className="mt-4">
            <ToolCallComponent
              icon={toolRegistry["tool-planning"]?.icon}
              title={toolRegistry["tool-planning"]?.title({}) || "Planning..."}
              isPending={true}
              isError={false}
            />
          </div>
        )}
    </MessageGroupWrapper>
  )
}, areGroupPropsEqual)
