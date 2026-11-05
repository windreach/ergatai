import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useAtomValue } from "jotai"
import { cn } from "@/lib/utils"
import { trpc } from "@/lib/trpc"
import { useConversationRuntime } from "../lib/conversation-runtime-gateway"
import type { ConversationRuntimeState } from "../lib/conversation-runtime-gateway"
import { buildRuntimeMessages } from "../lib/conversation-runtime-ui"
import { mapSessionMessage } from "../lib/session-message-mapper"
import { attachSideCopyProjectionsToTrace } from "../lib/side-copy-projection"
import {
  type ChatConversation,
} from "../lib/chat-contract-api"
import { SideChat } from "./side-chat"
import { loadingConversationsAtom } from "../../agents"
import { useSideChatController } from "../hooks/use-side-chat-controller"

// ============================================================================
// SideChatView
// ============================================================================

/** Minimal info about the active side chat, reported to the parent sidebar */
export interface ActiveSideChatInfo {
  id: string
  agent: { id: string; name: string }
}

interface SideChatViewProps {
  chatId: string
  /**
   * Whether the chat tab is currently visible (sidebar open + chat tab
   * active). Data fetching is deferred until first activation.
   */
  isActive?: boolean
  onActiveSideChatChange?: (info: ActiveSideChatInfo | null) => void
  projectPath?: string | null
  repository?: string
  sandboxId?: string
  teamId?: string
}

export function SideChatView({ chatId, isActive = true, onActiveSideChatChange, projectPath, repository, sandboxId, teamId }: SideChatViewProps) {
  const controller = useSideChatController(chatId, isActive)

  const {
    allAgentsRef,
    chatAgentsLoaded,
    sideChats,
    activeSideChatId,
    setActiveSideChatId,
    isCreatingSideChat,
    creatingAgentIds,
    bindingLoadingTimedOut,
    agentBindingsQuery,
    boundAgentIds,
    availableSideChatAgents,
    activeSideChat,
    activeBackendConversationId,
    activeAgentBinding,
    processAgentRequest,
    handleCloseSideChat,
  } = controller

  const loadingConversations = useAtomValue(loadingConversationsAtom)
  const loadingSideChatIds = useMemo(
    () => new Set(loadingConversations.keys()),
    [loadingConversations],
  )

  const runtime = useConversationRuntime(activeBackendConversationId, isActive)

  const messagesQuery = trpc.ergatai.listConversationMessages.useQuery(
    { conversationId: activeBackendConversationId ?? "" },
    { enabled: isActive && !!activeBackendConversationId },
  )
  const trpcUtils = trpc.useUtils()
  const reconciledRuntimeTurnsRef = useRef<Set<string>>(new Set())
  const prevConnectionStatusRef = useRef<ConversationRuntimeState["connectionStatus"] | undefined>(undefined)
  const prevIsActiveRef = useRef<boolean>(isActive)

  // Reset the reconcile guard whenever the active side conversation changes so a
  // previously viewed (and already reconciled) turn can be refetched after the
  // user switches away and back.
  useEffect(() => {
    reconciledRuntimeTurnsRef.current.clear()
  }, [activeBackendConversationId])

  // When the live SSE stream recovers from a reconnect, force a persisted-message
  // resync so any events missed during the outage are repaired instead of leaving
  // the side chat stuck on stale content.
  useEffect(() => {
    const previous = prevConnectionStatusRef.current
    prevConnectionStatusRef.current = runtime?.connectionStatus
    if (!isActive || !activeBackendConversationId) return
    if (previous === "reconnecting" && runtime?.connectionStatus === "connected") {
      void messagesQuery.refetch()
      void trpcUtils.chats.get.invalidate({ id: chatId })
    }
  }, [isActive, activeBackendConversationId, chatId, messagesQuery.refetch, runtime?.connectionStatus, trpcUtils])

  // Side chat panels are frequently activated/deactivated. When a panel becomes
  // active again, refresh persisted messages so the user immediately sees the
  // latest state instead of waiting for the next terminal turn.
  useEffect(() => {
    const wasInactive = !prevIsActiveRef.current
    prevIsActiveRef.current = isActive
    if (!wasInactive || !isActive || !activeBackendConversationId) return
    void messagesQuery.refetch()
  }, [isActive, activeBackendConversationId, messagesQuery.refetch])

  const persistedMessages = useMemo(
    () => attachSideCopyProjectionsToTrace(messagesQuery.data ?? []).map(mapSessionMessage),
    [messagesQuery.data],
  )
  const activeConversationMessages = persistedMessages

  const runtimeMessages = useMemo(
    () => buildRuntimeMessages(runtime),
    [runtime],
  )

  useEffect(() => {
    if (!activeBackendConversationId) return
    console.debug("[SideChatRuntime]", {
      conversationId: activeBackendConversationId,
      isActive,
      connectionStatus: runtime?.connectionStatus,
      status: runtime?.status,
      turnId: runtime?.turnId,
      lastSequence: runtime?.lastSequence,
      persistedCount: persistedMessages.length,
      runtimeCount: runtimeMessages.length,
    })
  }, [
    activeBackendConversationId,
    isActive,
    persistedMessages.length,
    runtime?.connectionStatus,
    runtime?.lastSequence,
    runtime?.status,
    runtime?.turnId,
    runtimeMessages.length,
  ])

  const isSideChatMessagesLoading =
    !!activeBackendConversationId &&
    persistedMessages.length === 0 &&
    messagesQuery.isLoading

  useEffect(() => {
    const terminal = runtime?.status === "completed" || runtime?.status === "error"
    if (!terminal || !activeBackendConversationId) return

    const reconcileKey = [
      activeBackendConversationId,
      runtime?.turnId ?? "",
      runtime?.lastSequence ?? 0,
      runtime?.status ?? "",
    ].join(":")
    if (reconciledRuntimeTurnsRef.current.has(reconcileKey)) return
    reconciledRuntimeTurnsRef.current.add(reconcileKey)

    // SideChat's runtime-session hook already reconciles terminal turns by
    // invalidating both the conversation query and the parent chat snapshot.
    // Repeating it here caused two full-chat refreshes for the same turn.
    void messagesQuery.refetch()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    chatId,
    activeBackendConversationId,
    messagesQuery.refetch,
    runtime?.lastSequence,
    runtime?.status,
    runtime?.turnId,
  ])

  useEffect(() => {
    onActiveSideChatChange?.(
      activeSideChat
        ? {
            id: activeSideChat.id,
            agent: { id: activeSideChat.agent.id, name: activeSideChat.agent.name },
          }
        : null,
    )
  }, [activeSideChat, onActiveSideChatChange])

  return (
    <>
      {activeSideChat ? (
        agentBindingsQuery.isLoading &&
        !agentBindingsQuery.isError &&
        !bindingLoadingTimedOut &&
        chatId.startsWith("chat_") ? (
          <div className="flex flex-1 items-center justify-center">
            <div className="text-xs text-muted-foreground">Loading agent binding…</div>
          </div>
        ) : (
        <SideChat
          key={activeSideChat.id}
          conversation={{
            ...activeSideChat,
            messages: activeConversationMessages,
          }}
          chatId={chatId}
          isActive={isActive}
          agentId={activeAgentBinding?.agentId ?? null}
          projectPath={projectPath}
          repository={repository}
          sandboxId={sandboxId}
          teamId={teamId}
          isLoadingMessages={isSideChatMessagesLoading}
          externalMessages={runtimeMessages}
          runtimeStatus={runtime?.status}
          runtimeConnectionStatus={runtime?.connectionStatus}
        />
        )
      ) : (
        <div className="flex flex-1 items-center justify-center">
          <div className="w-full max-w-64 px-6 text-center">
            <p className="text-sm font-medium">Click an agent in the rail to start chatting</p>
          </div>
        </div>
      )}
    </>
  )
}
