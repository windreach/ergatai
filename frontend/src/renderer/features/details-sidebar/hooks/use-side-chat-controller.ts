import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useAtom, useAtomValue } from "jotai"
import { toast } from "sonner"
import { trpc } from "@/lib/trpc"
import { groupAgentChatRequestAtomFamily } from "../../agents"
import { chatContractApi } from "../lib/chat-contract-api"
import {
  type ChatConversation,
} from "../lib/chat-contract-api"
import { agentContractApi } from "../../agents/public"
import {
  CORE_AGENT_OPTIONS,
  type CoreAgentId,
  type CoreAgentOption,
} from "../../agents/public"

export interface SideChatController {
  allAgentsRef: React.MutableRefObject<CoreAgentOption[]>
  chatAgentsLoaded: boolean
  sideChats: ChatConversation[]
  activeSideChatId: string | null
  setActiveSideChatId: (id: string | null) => void
  isCreatingSideChat: boolean
  creatingAgentIds: Set<string>
  bindingLoadingTimedOut: boolean
  agentBindingsQuery: ReturnType<typeof trpc.ergatai.getAgentBindings.useQuery>
  boundAgentIds: Set<string>
  openedAgentIds: Set<string>
  availableSideChatAgents: CoreAgentOption[]
  activeSideChat: ChatConversation | null
  activeBackendConversationId: string | undefined
  activeAgentBinding: any
  processAgentRequest: (agent: CoreAgentOption, backendConversationId?: string) => Promise<void>
  handleCloseSideChat: (conversationId: string) => void
}

export function useSideChatController(chatId: string, isActive: boolean): SideChatController {
  const allAgentsRef = useRef<CoreAgentOption[]>([])
  const creatingAgentIdsRef = useRef<Set<string>>(new Set())
  const [chatAgentsLoaded, setChatAgentsLoaded] = useState(false)
  const [sideChats, setSideChats] = useState<ChatConversation[]>([])
  const [activeSideChatId, setActiveSideChatId] = useState<string | null>(null)
  const [isCreatingSideChat, setIsCreatingSideChat] = useState(false)
  const [creatingAgentIds, setCreatingAgentIds] = useState<Set<string>>(new Set())
  const [bindingLoadingTimedOut, setBindingLoadingTimedOut] = useState(false)

  const [agentChatRequest, setAgentChatRequest] = useAtom(
    groupAgentChatRequestAtomFamily(chatId),
  )
  const agentBindingsQuery = trpc.ergatai.getAgentBindings.useQuery(
    { chatId },
    { enabled: isActive && chatId.startsWith("chat_") },
  )

  useEffect(() => {
    if (!agentBindingsQuery.isLoading) {
      setBindingLoadingTimedOut(false)
      return
    }
    const timer = setTimeout(() => setBindingLoadingTimedOut(true), 3000)
    return () => clearTimeout(timer)
  }, [agentBindingsQuery.isLoading])

  const boundAgentIds = useMemo(() => {
    return new Set(agentBindingsQuery.data?.map((b) => b.agentId) ?? [])
  }, [agentBindingsQuery.data])

  const openedAgentIds = useMemo(
    () => new Set(sideChats.map((conversation) => conversation.agent.id)),
    [sideChats],
  )

  const availableSideChatAgents = useMemo(() => {
    if (!chatAgentsLoaded) return []
    // agent.id here is a profile-level (CoreAgentOption) id, not a runtime agent_id.
    return allAgentsRef.current.filter(
      (agent) => boundAgentIds.has(agent.id) && !openedAgentIds.has(agent.id),
    )
  }, [boundAgentIds, openedAgentIds, chatAgentsLoaded])

  const activeSideChat = useMemo(
    () => sideChats.find((conversation) => conversation.id === activeSideChatId) ?? null,
    [activeSideChatId, sideChats],
  )

  const activeBackendConversationId = activeSideChat?.backendConversationId

  const activeAgentBinding = useMemo(
    () => agentBindingsQuery.data?.find(
      (binding) => binding.conversationId === activeBackendConversationId,
    ) ?? null,
    [activeBackendConversationId, agentBindingsQuery.data],
  )

  useEffect(() => {
    allAgentsRef.current = []
    // react-doctor-disable-next-line no-adjust-state-on-prop-change
    setChatAgentsLoaded(false)
    // react-doctor-disable-next-line no-adjust-state-on-prop-change
    setSideChats([])
    // react-doctor-disable-next-line no-adjust-state-on-prop-change
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

  const processAgentRequest = useCallback(async (
    agent: CoreAgentOption,
    backendConversationId?: string,
  ) => {
    const resolvedConversationId =
      backendConversationId ??
      agentBindingsQuery.data?.find((binding) => binding.agentId === agent.id)
        ?.conversationId

    if (!resolvedConversationId) {
      toast.error("This agent has no bound conversation yet")
      return
    }

    const existing = sideChats.find(
      (conversation) =>
        conversation.backendConversationId === resolvedConversationId ||
        conversation.agent.id === agent.id,
    )
    if (existing) {
      setActiveSideChatId(existing.id)
      return
    }

    if (creatingAgentIdsRef.current.has(agent.id)) return

    creatingAgentIdsRef.current.add(agent.id)
    setCreatingAgentIds((previous) => new Set(previous).add(agent.id))
    setIsCreatingSideChat(true)
    try {
      const conversation = await chatContractApi.createConversation(
        agent,
        resolvedConversationId,
      )

      setSideChats((current) =>
        current.some(
          (item) =>
            item.backendConversationId === resolvedConversationId ||
            item.agent.id === agent.id,
        )
          ? current
          : [...current, conversation],
      )
      setActiveSideChatId(conversation.id)
    } finally {
      creatingAgentIdsRef.current.delete(agent.id)
      setCreatingAgentIds((previous) => {
        const next = new Set(previous)
        next.delete(agent.id)
        return next
      })
      setIsCreatingSideChat(false)
    }
  // react-doctor-disable-next-line exhaustive-deps
  }, [agentBindingsQuery.data, sideChats, creatingAgentIds])

  const processAgentRequestRef = useRef(processAgentRequest)
  // react-doctor-disable-next-line no-ref-current-in-render
  processAgentRequestRef.current = processAgentRequest

  const stableProcessRequest = useCallback((agent: CoreAgentOption, backendConversationId?: string) => {
    processAgentRequestRef.current(agent, backendConversationId)
  }, [])

  useEffect(() => {
    if (!agentChatRequest) return
    const request = agentChatRequest

    const existingConversation = request.conversationId
      ? sideChats.find(
          (conversation) =>
            conversation.backendConversationId === request.conversationId,
        )
      : sideChats.find(
          (conversation) => conversation.agent.id === request.agentId,
        )

    if (existingConversation) {
      setAgentChatRequest(null)
      setActiveSideChatId(existingConversation.id)
      return
    }

    const groupAgent =
      allAgentsRef.current.find((agent) => agent.id === request.agentId) ??
      CORE_AGENT_OPTIONS.find((agent) => agent.id === request.agentId)

    if (!groupAgent) {
      const binding = request.conversationId
        ? agentBindingsQuery.data?.find(
            (item) => item.conversationId === request.conversationId,
          )
        : undefined
      if (!binding && (agentBindingsQuery.isLoading || !agentBindingsQuery.data)) {
        return
      }
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
    agentBindingsQuery.data,
    agentBindingsQuery.isLoading,
    setAgentChatRequest,
  ])

  const handleCloseSideChat = useCallback((conversationId: string) => {
    const closingIndex = sideChats.findIndex((conversation) => conversation.id === conversationId)
    const nextChats = sideChats.filter((conversation) => conversation.id !== conversationId)

    setSideChats(nextChats)
    if (conversationId === activeSideChatId) {
      const nextActive = nextChats[Math.min(closingIndex, nextChats.length - 1)]
      setActiveSideChatId(nextActive?.id ?? null)
    }
  }, [activeSideChatId, sideChats])

  return {
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
    openedAgentIds,
    availableSideChatAgents,
    activeSideChat,
    activeBackendConversationId,
    activeAgentBinding,
    processAgentRequest,
    handleCloseSideChat,
  }
}