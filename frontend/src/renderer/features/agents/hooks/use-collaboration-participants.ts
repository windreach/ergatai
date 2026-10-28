import { useEffect, useMemo, useState } from "react"
import { isCollaborationSessionRuntimeEnabled } from "../collaboration/collaboration-session-runtime"

interface CollaborationParticipant {
  conversationId: string
  agentId: string
  role: string
}

interface UseCollaborationParticipantsOptions {
  collaborationSessionEnabled: boolean
  isGroupMode: boolean
  groupAgents: Array<{ id: string; name?: string }>
  workspaceId: string | null
  parentChatId: string | null
  conversationId: string
  provider: string
}

export function useCollaborationParticipants({
  collaborationSessionEnabled,
  isGroupMode,
  groupAgents,
  workspaceId,
  parentChatId,
  conversationId,
  provider,
}: UseCollaborationParticipantsOptions) {
  const [collaborationParticipants, setCollaborationParticipants] = useState<CollaborationParticipant[]>([])

  // Memoize groupAgents to avoid unnecessary effect re-runs
  const stableGroupAgents = useMemo(
    () => groupAgents,
    [JSON.stringify(groupAgents.map(a => a.id))]
  )

  useEffect(() => {
    if (!collaborationSessionEnabled) {
      setCollaborationParticipants([])
      return
    }

    if (isGroupMode && stableGroupAgents.length > 0) {
      // For group mode: create a conversation for each agent
      // Both workspaceId and parentChatId are required
      if (!workspaceId) {
        console.error("[active-chat] Cannot create collaboration participants: workspaceId is required")
        setCollaborationParticipants([])
        return
      }

      if (!parentChatId) {
        console.error("[active-chat] Cannot create collaboration participants: parentChatId is required")
        setCollaborationParticipants([])
        return
      }

      // Synchronous computation - no async operations needed
      const participants = stableGroupAgents.map((agent) => ({
        conversationId: parentChatId,
        agentId: agent.id,
        role: "peer",
      }))

      setCollaborationParticipants(participants)
    } else {
      // For single agent mode: use the current conversation
      setCollaborationParticipants([{
        conversationId: conversationId || "",
        agentId: provider,
        role: "supervisor",
      }])
    }
  }, [
    collaborationSessionEnabled,
    isGroupMode,
    stableGroupAgents,
    workspaceId,
    parentChatId,
    conversationId,
    provider,
  ])

  return {
    collaborationParticipants,
    collaborationSessionEnabled: isCollaborationSessionRuntimeEnabled(),
  }
}
