import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useAtom } from "jotai"
import { Plus, X } from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { trpc } from "@/lib/trpc"
import { api } from "../../../lib/api-adapter"
import { groupAgentChatRequestAtomFamily } from "../../agents/collaboration/group-chat-context"
import {
  type ChatMessage,
  type ChatConversation,
} from "../lib/chat-contract-api"
import {
  agentContractApi,
  CORE_AGENT_OPTIONS,
  type CoreAgentId,
  type CoreAgentOption,
} from "../../agents/lib/agent-contract-api"
import { getCoreAgentIcon } from "../../agents/components/core-agent-selector"
import { SideChat } from "./side-chat"
import { useStreamingStatusStore } from "../../agents/stores/streaming-status-store"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

// ============================================================================
// Backend message mapping
// ============================================================================

/**
 * Infer message role from metadata (source + messageType).
 * Backend doesn't manage roles - it only stores source and messageType.
 *
 * Role semantics:
 * - "user": user as sender
 * - "agent": agent as sender (active message, no thinking/tools needed)
 * - "assistant": reply to user or agent (needs thinking/tools rendering)
 */
function inferMessageRole(
  source: string | undefined,
  messageType: string | undefined,
): "user" | "assistant" | "agent" {
  // User as sender
  if (source === "user") return "user"

  // System messages are rendered as assistant
  if (source === "system") return "assistant"

  // Agent as sender or replier
  if (source === "agent") {
    // Agent is sending a request → agent (sender)
    if (messageType === "request") return "agent"
    // Agent is replying (response/broadcast) or no messageType → assistant (replier)
    return "assistant"
  }

  // Unknown source - default to assistant
  return "assistant"
}

function getMessageText(parts: unknown[]) {
  return parts
    .map((part) => {
      if (!part || typeof part !== "object") return ""
      const candidate = part as { type?: unknown; text?: unknown }
      if (candidate.type !== "text") return ""
      return typeof candidate.text === "string" ? candidate.text : ""
    })
    .filter(Boolean)
    .join("\n\n")
}

function getReasoningText(parts: unknown[]) {
  return parts
    .map((part) => {
      if (!part || typeof part !== "object") return ""
      const candidate = part as { type?: unknown; text?: unknown }
      if (candidate.type !== "reasoning" || typeof candidate.text !== "string") return ""
      return candidate.text
    })
    .filter(Boolean)
    .join("\n\n")
}

function mapBackendMessage(message: {
  id: string
  role: string
  parts: unknown[]
  metadata?: Record<string, unknown> | null
}): ChatMessage {
  const metadata = message.metadata ?? undefined
  const readString = (key: string) => {
    const value = metadata?.[key]
    return typeof value === "string" && value.length > 0 ? value : undefined
  }
  const senderAgentId = readString("senderAgentId") ?? readString("agentId")
  const senderAgentName = readString("senderAgentName") ?? readString("agentName")
  const messageType = readString("messageType")
  const source = readString("source")

  // Infer role from metadata (source + messageType), not from backend's role field.
  // Backend doesn't manage roles - it only stores source and messageType.
  // Role semantics:
  // - "user": user as sender
  // - "agent": agent as sender (active message, no thinking/tools needed)
  // - "assistant": reply to user or agent (needs thinking/tools rendering)
  const role = inferMessageRole(source, messageType)

  const result: ChatMessage = {
    id: message.id,
    role,
    content: getMessageText(message.parts),
    reasoning: getReasoningText(message.parts) || undefined,
    senderAgentId,
    senderAgentName,
    metadata,
    parts: message.parts,
  }

  return result
}

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
  const allAgentsRef = useRef<CoreAgentOption[]>([])
  const [chatAgentsLoaded, setChatAgentsLoaded] = useState(false)
  const [sideChats, setSideChats] = useState<ChatConversation[]>([])
  const [activeSideChatId, setActiveSideChatId] = useState<string | null>(null)
  const [isCreatingSideChat, setIsCreatingSideChat] = useState(false)

  const activeSideChat = useMemo(
    () => sideChats.find((conversation) => conversation.id === activeSideChatId) ?? null,
    [activeSideChatId, sideChats],
  )

  const activeBackendConversationId = activeSideChat?.backendConversationId
  const [agentChatRequest, setAgentChatRequest] = useAtom(
    groupAgentChatRequestAtomFamily(chatId),
  )
  const agentBindingsQuery = trpc.ergatai.getAgentBindings.useQuery(
    { chatId },
    { enabled: isActive && chatId.startsWith("chat_") },
  )

  // Get list of agents already bound to this chat
  const boundAgentIds = useMemo(() => {
    return new Set(agentBindingsQuery.data?.map((b) => b.agentId) ?? [])
  }, [agentBindingsQuery.data])

  // Get all conversations for this chat to find agent's actual conversation
  const agentChatQuery = api.agents.getAgentChat.useQuery(
    { chatId },
    { enabled: isActive && chatId.startsWith("chat_") },
  )

  // Get streaming status to conditionally enable/disable message refetching
  const streamingStatus = useStreamingStatusStore(
    (state) => state.statuses[activeBackendConversationId ?? ""] ?? "ready"
  )

  const isStreaming = streamingStatus === "streaming" || streamingStatus === "submitted"

  // Get messages from agentChatQuery (same as main chat) - no polling needed!
  const activeConversation = useMemo(() => {
    if (!activeBackendConversationId || !agentChatQuery.data?.conversations) return null
    return agentChatQuery.data.conversations.find(
      (conv: any) => conv.id === activeBackendConversationId
    ) ?? null
  }, [activeBackendConversationId, agentChatQuery.data])

  const activeAgentBinding = useMemo(
    () => agentBindingsQuery.data?.find(
      (binding) => binding.conversationId === activeBackendConversationId,
    ) ?? null,
    [activeBackendConversationId, agentBindingsQuery.data],
  )

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

  // Reset state when chatId changes
  useEffect(() => {
    allAgentsRef.current = []
    setChatAgentsLoaded(false)
    setSideChats([])
    setActiveSideChatId(null)
  }, [chatId])

  useEffect(() => {
    if (!isActive || chatAgentsLoaded) return
    let cancelled = false

    agentContractApi.listCoreAgents().then((agents) => {
      if (cancelled) return
      allAgentsRef.current = agents
      setChatAgentsLoaded(true)
    })

    return () => {
      cancelled = true
    }
  }, [isActive, chatAgentsLoaded])

  const spawnAgentMutation = trpc.ergatai.spawnAgent.useMutation()

  // Track in-flight creations per agent. Opening one agent must not drop
  // clicks on other agents — those can be created in parallel.
  const creatingAgentIdsRef = useRef<Set<string>>(new Set())

  const processAgentRequest = useCallback(async (
    agent: CoreAgentOption,
    backendConversationId?: string,
  ) => {
    // Backend no longer supports creating child conversations and binding agents
    // This feature has been removed
    console.warn("[side-chat-view] createChildConversation and bindAgent are no longer supported")
    toast.error("Side chat feature is no longer supported")
    return
  }, [])

  // Stable ref for useEffect — doesn't change across renders
  const processAgentRequestRef = useRef(processAgentRequest)
  processAgentRequestRef.current = processAgentRequest

  const stableProcessRequest = useCallback((agent: CoreAgentOption, backendConversationId?: string) => {
    processAgentRequestRef.current(agent, backendConversationId)
  }, [])

  useEffect(() => {
    if (!agentChatRequest) return
    const request = agentChatRequest

    // Check if conversation already exists in sideChats
    const existingConversation = request.conversationId
      ? sideChats.find(
          (conversation) =>
            conversation.backendConversationId === request.conversationId,
        )
      : sideChats.find(
          (conversation) => conversation.agent.id === request.agentId,
        )

    if (existingConversation) {
      // Messages will be updated via agentChatQuery - no manual refetch needed
      setAgentChatRequest(null)
      setActiveSideChatId(existingConversation.id)
      return
    }

    // Try to find agent in loaded agents first, then fallback to CORE_AGENT_OPTIONS
    let groupAgent = allAgentsRef.current.find((agent) => agent.id === request.agentId)

    if (!groupAgent && chatAgentsLoaded) {
      // Fallback: get agent from CORE_AGENT_OPTIONS
      const fallbackAgent = CORE_AGENT_OPTIONS.find((agent) => agent.id === request.agentId)
      if (fallbackAgent) {
        groupAgent = fallbackAgent
      }
    }

    if (!groupAgent) {
      if (!chatAgentsLoaded) return
      // Runtime agents spawned by the backend (e.g. answering a supervisor
      // question) may not resolve to a core agent id. Fall back to the
      // binding's display name instead of silently dropping the request.
      const binding = request.conversationId
        ? agentBindingsQuery.data?.find(
            (item) => item.conversationId === request.conversationId,
          )
        : undefined
      if (!binding) {
        setAgentChatRequest(null)
        return
      }
      setAgentChatRequest(null)
      stableProcessRequest(
        {
          id: request.agentId,
          name: binding.agentName,
          defaultCommand: binding.agentCommand ?? request.agentId,
        },
        request.conversationId,
      )
      return
    }

    setAgentChatRequest(null)
    stableProcessRequest(groupAgent, request.conversationId)
  }, [
    stableProcessRequest,
    agentChatRequest,
    sideChats,
    chatAgentsLoaded,
    agentChatQuery.data,
    agentBindingsQuery.data,
  ])

  // Side chat uses the same data flow as main chat:
  // 1. agentChatQuery loads conversations with messages (no polling)
  // 2. useChatInstance hook handles real-time updates via Transport
  // 3. Messages are synced to Chat instance via conversation.messages prop

  const handleCloseSideChat = useCallback((conversationId: string) => {
    const closingIndex = sideChats.findIndex((conversation) => conversation.id === conversationId)
    const nextChats = sideChats.filter((conversation) => conversation.id !== conversationId)

    setSideChats(nextChats)
    if (conversationId === activeSideChatId) {
      const nextActive = nextChats[Math.min(closingIndex, nextChats.length - 1)]
      setActiveSideChatId(nextActive?.id ?? null)
    }
  }, [activeSideChatId, sideChats])

  return (
    <>
      {sideChats.length > 0 && (
        <div className="flex h-9 w-full min-w-0 flex-shrink-0 items-center border-b border-border/50">
          <div className="flex min-w-0 items-center gap-1 overflow-x-auto px-1 scrollbar-thin scrollbar-thumb-muted-foreground/20">
            {sideChats.map((conversation) => {
              const Icon = getCoreAgentIcon(conversation.agent.id as CoreAgentId)
              const isActive = conversation.id === activeSideChatId

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
                    <Icon className="h-3.5 w-3.5 flex-shrink-0" />
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
              {allAgentsRef.current
                .filter((agent) => !boundAgentIds.has(agent.id))
                .map((agent) => {
                  const Icon = getCoreAgentIcon(agent.id as CoreAgentId)

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
        <SideChat
          key={activeSideChat.id}
          conversation={{
            ...activeSideChat,
            messages: activeConversation?.messages ?? [],
          }}
          chatId={chatId}
          isActive={isActive}
          agentId={activeAgentBinding?.agentId ?? null}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center">
          <div className="w-full max-w-64 px-6 text-center">
            <p className="text-sm font-medium">Select an agent to chat</p>
            <div className="mt-5 space-y-3">
              {allAgentsRef.current
                .filter((agent) => !boundAgentIds.has(agent.id))
                .map((agent) => {
                  const Icon = getCoreAgentIcon(agent.id)

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
