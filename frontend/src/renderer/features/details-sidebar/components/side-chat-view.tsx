import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useAtomValue } from "jotai"
import { Plus, X } from "lucide-react"
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
import { getCoreAgentIcon } from "../../agents"
import { SideChat } from "./side-chat"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { loadingConversationsAtom } from "../../agents"
import { LoadingDot } from "../../../components/ui/icons"
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
}

export function SideChatView({ chatId, isActive = true, onActiveSideChatChange }: SideChatViewProps) {
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

    void Promise.all([
      messagesQuery.refetch(),
      trpcUtils.chats.get.invalidate({ id: chatId }),
    ])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    chatId,
    activeBackendConversationId,
    messagesQuery.refetch,
    runtime?.lastSequence,
    runtime?.status,
    runtime?.turnId,
    trpcUtils,
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
      {sideChats.length > 0 && (
        <div className="flex h-9 w-full min-w-0 flex-shrink-0 items-center border-b border-border/50">
          <div className="flex min-w-0 items-center gap-1 overflow-x-auto px-1 scrollbar-thin scrollbar-thumb-muted-foreground/20">
            {sideChats.map((conversation) => {
              const Icon = getCoreAgentIcon(conversation.agent.id as any)
              const isActive = conversation.id === activeSideChatId
              const loadingKey = conversation.backendConversationId ?? conversation.id
              const isLoading = loadingSideChatIds.has(loadingKey)

              return (
                <div
                  key={conversation.id}
                  className={cn(
                    "flex h-7 w-28 min-w-24 flex-shrink-0 items-center rounded-md border px-1 transition-colors",
                    isActive
                      ? "border-border bg-background text-foreground shadow-sm"
                      : "border-transparent bg-muted/40 text-muted-foreground hover:bg-muted/70 hover:text-foreground",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => setActiveSideChatId(conversation.id)}
                    className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden rounded-sm px-1 py-0.5 text-left"
                  >
                    <div className="relative flex-shrink-0">
                      <Icon className="h-3.5 w-3.5" />
                      {isLoading && (
                        <div
                          className={cn(
                            "absolute -bottom-1 -right-1 w-3 h-3 rounded-full flex items-center justify-center",
                            isActive
                              ? "bg-[#E8E8E8] dark:bg-[#1B1B1B]"
                              : "bg-[#F4F4F4] dark:bg-[#101010]",
                          )}
                        >
                          <LoadingDot isLoading={true} className="w-2.5 h-2.5 text-muted-foreground" />
                        </div>
                      )}
                    </div>
                    <span className="min-w-0 truncate text-xs font-medium">
                      {conversation.agent.name}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleCloseSideChat(conversation.id)}
                    aria-label={`Close ${conversation.agent.name} chat`}
                    className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              )
            })}
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="New side chat"
                className="flex h-7 w-6 flex-shrink-0 items-center justify-center rounded-md bg-muted/40 text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground mr-1"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              {availableSideChatAgents.map((agent) => {
                const Icon = getCoreAgentIcon(agent.id as any)

                return (
                  <DropdownMenuItem
                    key={agent.id}
                    disabled={isCreatingSideChat}
                    onSelect={() => {
                      void processAgentRequest(agent)
                    }}
                    className="flex items-center gap-2 text-xs"
                  >
                    <Icon className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                    <span className="min-w-0 truncate">{agent.name}</span>
                  </DropdownMenuItem>
                )
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
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
          isLoadingMessages={isSideChatMessagesLoading}
          externalMessages={runtimeMessages}
          runtimeStatus={runtime?.status}
          runtimeConnectionStatus={runtime?.connectionStatus}
        />
        )
      ) : (
        <div className="flex flex-1 items-center justify-center">
          <div className="w-full max-w-64 px-6 text-center">
            <p className="text-sm font-medium">Select an agent to chat</p>
            <div className="mt-5 space-y-3">
              {availableSideChatAgents.map((agent) => {
                const Icon = getCoreAgentIcon(agent.id as any)

                return (
                  <button
                    key={agent.id}
                    type="button"
                    disabled={isCreatingSideChat}
                    onClick={() => {
                      void processAgentRequest(agent)
                    }}
                    className="flex w-full items-center gap-2 rounded-lg border border-border/70 bg-background px-3 py-2 text-sm transition-colors hover:bg-accent/50 disabled:opacity-50"
                  >
                    <Icon className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                    <span className="truncate">{agent.name}</span>
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      )}
    </>
  )
}