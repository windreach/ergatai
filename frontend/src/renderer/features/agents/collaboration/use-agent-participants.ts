"use client"

import { useEffect, useMemo, useRef } from "react"

import { trpc } from "../../../lib/trpc"
import {
  getCoreAgentProfileName,
  type AgentSummary,
} from "../lib/agent-contract-api"
import { useAgentRuntimeAgents } from "../lib/agent-runtime-status-store"
import { useAgentConversationStore } from "../stores/conversation-store"
import { useGroupChat } from "./group-chat-context"
import {
  useGroupAgentRuntimeStatuses,
  type GroupAgentRuntimeStatus,
} from "./group-agent-runtime"
import type {
  AgentParticipant,
  AgentParticipantStatus,
} from "./agent-participant"

const STATUS_ORDER: Record<AgentParticipantStatus, number> = {
  running: 0,
  pending: 1,
  failed: 2,
  completed: 3,
  idle: 4,
  unknown: 5,
}

function mapGroupStatus(
  status: GroupAgentRuntimeStatus | undefined,
): AgentParticipantStatus {
  return status ?? "idle"
}

function mapRuntimeStatus(status: AgentSummary["status"]): AgentParticipantStatus {
  if (status === "working") return "running"
  if (status === "error") return "failed"
  if (status === "idle") return "idle"
  return "unknown"
}

function inferCoreAgentId(value?: string | null) {
  const normalized = value?.toLowerCase() ?? ""

  if (normalized.includes("codex")) return "codex" as const
  if (normalized.includes("cursor")) return "cursor" as const
  if (normalized.includes("opencode")) return "opencode" as const
  if (normalized.includes("claude")) return "claude-code" as const

  return undefined
}

interface UseAgentParticipantsInput {
  chatId: string
  workspaceId?: string | null
  runtimeWorkspaceId?: string | null
  supervisorAgentId?: string | null
}

export function useAgentParticipants({
  chatId,
  workspaceId,
  runtimeWorkspaceId,
  supervisorAgentId,
}: UseAgentParticipantsInput) {
  const { agents: groupAgents, isGroupChat } = useGroupChat()
  const ensuredGroupMembersRef = useRef<Set<string>>(new Set())
  const isPersistedChat = chatId.startsWith("chat_")
  const runtimeStatuses = useGroupAgentRuntimeStatuses(chatId)
  const { data: groupMembers, refetch: refetchGroupMembers } =
    trpc.groupChat.listMembers.useQuery(
      { chatId },
      { enabled: isGroupChat },
    )
  const { data: runtimeBindings } = trpc.ergatai.getAgentBindings.useQuery(
    { chatId },
    { enabled: !isGroupChat && isPersistedChat, refetchInterval: 5000 },
  )
  // Conversation currently displayed in the main chat. The supervisor's
  // binding points at this conversation, so it identifies the supervisor.
  const activeConversationId = useAgentConversationStore(
    (state) => state.activeConversationId,
  )
  const addGroupMember = trpc.groupChat.addMember.useMutation()
  const runtimeStatus = useAgentRuntimeAgents(!isGroupChat)
  const runtimeAgents = runtimeStatus.agents

  useEffect(() => {
    if (!isGroupChat || !groupMembers) return

    const missingAgents = groupAgents.filter((agent) => {
      const key = `${chatId}:${agent.id}`
      return (
        !ensuredGroupMembersRef.current.has(key) &&
        !groupMembers.some(
          (member) =>
            member.agentCommand === getCoreAgentProfileName(agent) ||
            member.agentName === agent.name,
        )
      )
    })

    if (missingAgents.length === 0) return

    let cancelled = false

    const ensureMembers = async () => {
      for (const agent of missingAgents) {
        if (cancelled) return
        const key = `${chatId}:${agent.id}`
        ensuredGroupMembersRef.current.add(key)

        try {
          await addGroupMember.mutateAsync({
            chatId,
            agentCommand: getCoreAgentProfileName(agent),
            agentName: agent.name,
            workspaceId: workspaceId || undefined,
          })
        } catch {
          ensuredGroupMembersRef.current.delete(key)
        }
      }

      if (!cancelled) void refetchGroupMembers()
    }

    void ensureMembers()

    return () => {
      cancelled = true
    }
  }, [
    addGroupMember,
    chatId,
    groupAgents,
    groupMembers,
    isGroupChat,
    refetchGroupMembers,
    workspaceId,
  ])

  return useMemo(() => {
    if (isGroupChat) {
      return groupAgents.map<AgentParticipant>((agent) => {
        const status = runtimeStatuses[agent.id]
        const member = groupMembers?.find(
          (row) =>
            row.agentCommand === getCoreAgentProfileName(agent) ||
            row.agentName === agent.name,
        )

        return {
          activity: "Bound to the active group chat",
          agentId: agent.id,
          coreAgentId: agent.id,
          key: `group:${agent.id}`,
          name: agent.name,
          source: "group",
          status: mapGroupStatus(status),
          conversationId: member?.conversationId ?? undefined,
          workspaceId: chatId,
        }
      })
    }

    // Several runtime agents can end up bound to the same conversation (e.g.
    // the backend auto-spawns an answerer and the UI spawned another). The
    // list opens conversations, so keep only the newest binding per
    // conversation to avoid duplicate entries.
    const newestBindingByConversation = new Map<
      string,
      { agentId: string; createdAt: Date }
    >()
    for (const binding of runtimeBindings ?? []) {
      const existing = newestBindingByConversation.get(binding.conversationId)
      if (!existing || binding.createdAt > existing.createdAt) {
        newestBindingByConversation.set(binding.conversationId, {
          agentId: binding.agentId,
          createdAt: binding.createdAt,
        })
      }
    }
    const visibleBindingAgentIds = new Set(
      [...newestBindingByConversation.values()].map((entry) => entry.agentId),
    )

    const scopedRuntimeAgents = runtimeAgents.filter(
      (agent) => visibleBindingAgentIds.has(agent.id),
    )
      .filter((agent) => {
        const coreAgentId =
          inferCoreAgentId(agent.profile) ?? inferCoreAgentId(agent.name)

        return !supervisorAgentId || coreAgentId !== supervisorAgentId
      })
      // The supervisor's own binding points at the main conversation (a
      // child conversation such as "conv_…", or the chatId itself in the
      // legacy model) — it drives the main chat, not a side chat, so it is
      // never a side-chat participant. Excluded by binding identity (not
      // agent type) so same-type side agents still show.
      .filter(
        (agent) =>
          !runtimeBindings?.some(
            (binding) =>
              binding.agentId === agent.id &&
              (binding.conversationId === chatId ||
                binding.conversationId === activeConversationId),
          ),
      )

    // Include stopped agents: those in bindings but not in runtime agents.
    // Backend returns all bindings (including stopped ones), but runtimeAgents
    // only contains alive agents. We need to show stopped agents too so users
    // can still see the full participant list and access historical conversations.
    const aliveAgentIds = new Set(scopedRuntimeAgents.map((a) => a.id))
    const stoppedAgents = (runtimeBindings ?? [])
      .filter((binding) => !aliveAgentIds.has(binding.agentId))
      .filter((binding) => {
        const coreAgentId =
          inferCoreAgentId(binding.agentCommand) ?? inferCoreAgentId(binding.agentName)
        return !supervisorAgentId || coreAgentId !== supervisorAgentId
      })
      .filter(
        (binding) =>
          binding.conversationId !== chatId &&
          binding.conversationId !== activeConversationId,
      )

      return [
        ...scopedRuntimeAgents.map<AgentParticipant>((agent) => ({
          activity: agent.sessionTitle || agent.description,
          agentId: agent.id,
          coreAgentId:
            inferCoreAgentId(agent.profile) ?? inferCoreAgentId(agent.name),
          key: `runtime:${agent.id}`,
          name: agent.name,
          profile: agent.profile,
          source: "runtime",
          status: mapRuntimeStatus(agent.status),
          conversationId: runtimeBindings?.find(
            (binding) => binding.agentId === agent.id,
          )?.conversationId,
          workspaceId: agent.workspaceId,
        })),
        ...stoppedAgents.map<AgentParticipant>((binding) => ({
          activity: "Agent stopped",
          agentId: binding.agentId,
          coreAgentId:
            inferCoreAgentId(binding.agentCommand) ?? inferCoreAgentId(binding.agentName),
          key: `stopped:${binding.agentId}`,
          name: binding.agentName,
          profile: binding.agentCommand,
          source: "stopped",
          status: "completed",
          conversationId: binding.conversationId,
          workspaceId: binding.workspaceId,
        })),
      ].sort(
        (left, right) =>
          STATUS_ORDER[left.status] - STATUS_ORDER[right.status] ||
          left.name.localeCompare(right.name),
      )
  }, [
    chatId,
    groupAgents,
    groupMembers,
    isGroupChat,
    runtimeAgents,
    runtimeStatuses,
    runtimeBindings,
    activeConversationId,
    workspaceId,
    runtimeWorkspaceId,
    supervisorAgentId,
  ])
}
