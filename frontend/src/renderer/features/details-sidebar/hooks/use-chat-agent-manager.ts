import i18n from "@/lib/i18n"
import { useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { trpc, trpcClient } from "../../../lib/trpc"
import {
  getCoreAgentDisplayName,
  type CoreAgentId,
  type CoreAgentOption,
} from "../../agents/public"

interface AgentProfileParticipant {
  agentId: string
  coreAgentId?: string
  profile?: string | null
  conversationId?: string
}

interface UseChatAgentManagerOptions {
  chatId: string
  activeConversationId?: string | null
  participants: AgentProfileParticipant[]
  coreAgents: CoreAgentOption[]
  canCreateAgent: boolean
  openAgentChat: (
    agentId: string,
    coreAgentId: CoreAgentId | undefined,
    conversationId: string | undefined,
  ) => void
}

interface ChatAgentManager {
  /** Profiles that are not already running or pending in this chat. */
  availableAgents: CoreAgentOption[]
  bindingsLoading: boolean
  isAgentCreating: (agent: CoreAgentOption) => boolean
  handleSelectAgent: (agent: CoreAgentOption) => Promise<void>
  /** Drop a local pending marker after the agent was explicitly deleted. */
  forgetAgentProfile: (agent: {
    profile?: string | null
    coreAgentId?: string
  }) => void
  refreshBindings: () => Promise<void>
}

// Profile-level identity for the "New agent" menu. Known core agents may be
// registered under their legacy name ("claude") or canonical id
// ("claude-code"), and both render as the same display name. Treat them as the
// same agent so the menu cannot offer a second instance of an existing type.
function toAgentProfileKey(value?: string | null): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed) return undefined
  return (getCoreAgentDisplayName(trimmed) ?? trimmed).toLowerCase()
}

function collectAgentProfileKeys(agent: CoreAgentOption): Set<string> {
  const keys = new Set<string>()
  for (const value of [agent.id, agent.profileName, agent.name]) {
    const key = toAgentProfileKey(value)
    if (key) keys.add(key)
  }
  return keys
}

function matchesAgentProfile(
  keys: Set<string>,
  ...values: Array<string | null | undefined>
): boolean {
  return values.some((value) => {
    const key = toAgentProfileKey(value)
    return key ? keys.has(key) : false
  })
}

/**
 * Owns the "New agent" creation flow for a chat:
 *
 * - Reuses an existing participant/binding for the same profile instead of
 *   spawning a duplicate runtime process.
 * - Blocks concurrent selections for the same profile and keeps a local
 *   pending marker until the backend's agent list catches up.
 * - Prevents creating side agents for a draft/project scope with no chat.
 */
export function useChatAgentManager({
  chatId,
  activeConversationId,
  participants,
  coreAgents,
  canCreateAgent,
  openAgentChat,
}: UseChatAgentManagerOptions): ChatAgentManager {
  const bindingsQuery = trpc.ergatai.getAgentBindings.useQuery(
    { chatId },
    { enabled: chatId.startsWith("chat_") },
  )
  const utils = trpc.useUtils()
  const spawnMutation = trpc.ergatai.spawnAgent.useMutation()
  const [creatingAgentKeys, setCreatingAgentKeys] = useState<Set<string>>(
    new Set(),
  )
  // Agent keys created by this widget that the backend has not reported back
  // yet. Kept local so a second selection during the spawn round-trip cannot
  // create a duplicate.
  const [pendingAgentKeys, setPendingAgentKeys] = useState<Set<string>>(
    new Set(),
  )
  const creatingAgentKeysRef = useRef<Set<string>>(new Set())
  const lastChatIdRef = useRef(chatId)
  const bindingsLoading = canCreateAgent && bindingsQuery.isLoading

  // Creation state is per chat; a stale pending profile from the previous
  // chat must not hide the menu entry in the new one.
  useEffect(() => {
    if (lastChatIdRef.current === chatId) return
    lastChatIdRef.current = chatId
    creatingAgentKeysRef.current.clear()
    setCreatingAgentKeys(new Set())
    setPendingAgentKeys(new Set())
  }, [chatId])

  const existingAgentKeys = useMemo(() => {
    const keys = new Set<string>()
    for (const participant of participants) {
      for (const value of [
        participant.coreAgentId,
        participant.profile,
        participant.agentId,
      ]) {
        const key = toAgentProfileKey(value)
        if (key) keys.add(key)
      }
    }
    for (const binding of bindingsQuery.data ?? []) {
      for (const value of [binding.agentCommand, binding.agentName]) {
        const key = toAgentProfileKey(value)
        if (key) keys.add(key)
      }
    }
    return keys
  }, [participants, bindingsQuery.data])

  // Once the backend list contains a locally created agent, the normal
  // existing-agent filter takes over and the local placeholder can be dropped.
  useEffect(() => {
    if (pendingAgentKeys.size === 0) return
    let settled = false
    for (const key of pendingAgentKeys) {
      if (existingAgentKeys.has(key)) {
        settled = true
        break
      }
    }
    if (!settled) return

    setPendingAgentKeys((previous) => {
      const next = new Set(previous)
      for (const key of existingAgentKeys) next.delete(key)
      return next.size === previous.size ? previous : next
    })
  }, [existingAgentKeys, pendingAgentKeys])

  const availableAgents = useMemo(
    () =>
      coreAgents.filter((agent) => {
        const keys = collectAgentProfileKeys(agent)
        for (const key of keys) {
          if (existingAgentKeys.has(key) || pendingAgentKeys.has(key)) {
            return false
          }
        }
        return true
      }),
    [coreAgents, existingAgentKeys, pendingAgentKeys],
  )

  const isPrimaryConversation = (conversationId?: string | null) =>
    Boolean(conversationId) &&
    (conversationId === chatId || conversationId === activeConversationId)

  const findReusableAgent = (agent: CoreAgentOption) => {
    const keys = collectAgentProfileKeys(agent)

    // Prefer a side-chat participant: opening it reuses its conversation and
    // avoids spawning another runtime process for the same profile.
    const participant = participants.find((candidate) =>
      matchesAgentProfile(keys, candidate.profile, candidate.coreAgentId),
    )
    if (participant?.conversationId) {
      return {
        agentId: participant.agentId,
        coreAgentId: participant.coreAgentId,
        conversationId: participant.conversationId,
      }
    }

    // Stopped side agents live only in the durable binding list. The main
    // conversation's agent is not a side-chat participant and must not be
    // reopened here; it is handled as "already active" below.
    const binding = bindingsQuery.data?.find(
      (candidate) =>
        !isPrimaryConversation(candidate.conversationId) &&
        matchesAgentProfile(keys, candidate.agentCommand, candidate.agentName),
    )
    if (binding?.conversationId) {
      return {
        agentId: binding.agentId,
        coreAgentId: agent.id as CoreAgentId,
        conversationId: binding.conversationId,
      }
    }

    return null
  }

  const handleSelectAgent = async (agent: CoreAgentOption) => {
    const profileKey = toAgentProfileKey(agent.profileName ?? agent.id)
    if (profileKey && creatingAgentKeysRef.current.has(profileKey)) return

    const agentKeys = collectAgentProfileKeys(agent)
    const reusable = findReusableAgent(agent)
    if (reusable) {
      openAgentChat(
        reusable.agentId,
        reusable.coreAgentId,
        reusable.conversationId,
      )
      return
    }

    const primaryBinding = bindingsQuery.data?.find(
      (candidate) =>
        isPrimaryConversation(candidate.conversationId) &&
        matchesAgentProfile(
          agentKeys,
          candidate.agentCommand,
          candidate.agentName,
        ),
    )
    if (primaryBinding) {
      toast.info(i18n.t("This agent is already active in this chat"))
      return
    }

    if (!canCreateAgent) {
      toast.error(i18n.t("Create the chat before adding an agent"))
      return
    }

    if (bindingsLoading) return

    if (profileKey) {
      creatingAgentKeysRef.current.add(profileKey)
      setCreatingAgentKeys((previous) => new Set(previous).add(profileKey))
    }
    // Hide the menu entry immediately; the backend list only catches up after
    // the spawn + binding round-trip.
    setPendingAgentKeys((previous) => {
      const next = new Set(previous)
      for (const key of agentKeys) next.add(key)
      return next
    })

    try {
      const conversation = await trpcClient.ergatai.createConversation.mutate({
        chatId,
        title: agent.name,
        mode: "agent",
      })
      const newConversationId = conversation.id
      const spawnResult = await spawnMutation.mutateAsync({
        conversationId: newConversationId,
        command: agent.profileName || agent.id,
      })
      const spawnedAgentId = spawnResult?.agent_id
      await utils.ergatai.getAgentBindings.invalidate({ chatId })
      const result = await bindingsQuery.refetch()
      const binding =
        result.data?.find(
          (item) =>
            item.agentId === spawnedAgentId ||
            item.conversationId === newConversationId,
        ) ??
        result.data?.find(
          (item) =>
            !isPrimaryConversation(item.conversationId) &&
            matchesAgentProfile(
              agentKeys,
              item.agentCommand,
              item.agentName,
            ),
        )
      openAgentChat(
        spawnedAgentId ?? agent.id,
        agent.id as CoreAgentId,
        binding?.conversationId ?? newConversationId,
      )
    } catch (error) {
      setPendingAgentKeys((previous) => {
        const next = new Set(previous)
        for (const key of agentKeys) next.delete(key)
        return next
      })
      console.error("Failed to start agent", error)
      toast.error("Failed to start agent", {
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      if (profileKey) {
        creatingAgentKeysRef.current.delete(profileKey)
        setCreatingAgentKeys((previous) => {
          if (!previous.has(profileKey)) return previous
          const next = new Set(previous)
          next.delete(profileKey)
          return next
        })
      }
    }
  }

  const forgetAgentProfile = (agent: {
    profile?: string | null
    coreAgentId?: string
  }) => {
    setPendingAgentKeys((previous) => {
      const next = new Set(previous)
      for (const value of [agent.profile, agent.coreAgentId]) {
        const key = toAgentProfileKey(value)
        if (key) next.delete(key)
      }
      return next.size === previous.size ? previous : next
    })
  }

  const refreshBindings = async () => {
    await utils.ergatai.getAgentBindings.invalidate({ chatId })
    await bindingsQuery.refetch()
  }

  return {
    availableAgents,
    bindingsLoading,
    isAgentCreating: (agent) => {
      const key = toAgentProfileKey(agent.profileName ?? agent.id)
      return key ? creatingAgentKeys.has(key) : false
    },
    handleSelectAgent,
    forgetAgentProfile,
    refreshBindings,
  }
}
