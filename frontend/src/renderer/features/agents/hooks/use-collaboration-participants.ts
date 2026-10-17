import { useEffect, useState } from "react"
import { trpcClient } from "../../../lib/trpc"
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

  useEffect(() => {
    let isMounted = true

    const createParticipants = async () => {
      if (!collaborationSessionEnabled) return

      try {
        if (isGroupMode && groupAgents.length > 0) {
          // For group mode: create a conversation for each agent
          // workspaceId is required for creating conversations
          if (!workspaceId) {
            console.error("[active-chat] Cannot create collaboration participants: workspaceId is required")
            return
          }

          const participants = await Promise.all(
            groupAgents.map(async (agent) => {
              try {
                // Check if still mounted
                if (!isMounted) return null

                // Backend no longer supports child conversations
                // Use parent conversation for all agents
                return {
                  conversationId: parentChatId,
                  agentId: agent.id,
                  role: "peer",
                }
              } catch (err) {
                // Check if still mounted
                if (!isMounted) return null
                console.error(`[active-chat] Failed to create participant for agent ${agent.id}:`, err)
                // Fallback: use parent chat's conversation
                return {
                  conversationId: conversationId,
                  agentId: agent.id,
                  role: "peer",
                }
              }
            })
          )

          // Filter out null values and update state only if still mounted
          if (isMounted) {
            const validParticipants = participants.filter((p): p is NonNullable<typeof p> => p !== null)
            setCollaborationParticipants(validParticipants.map(p => ({
              conversationId: p.conversationId || "",
              agentId: p.agentId,
              role: p.role,
            })))
          }
        } else {
          // For single agent mode: use the current conversation
          if (isMounted) {
            setCollaborationParticipants([{
              conversationId: conversationId || "",
              agentId: provider,
              role: "supervisor",
            }])
          }
        }
      } catch (err) {
        if (isMounted) {
          console.error("[active-chat] Failed to create collaboration participants:", err)
          // Fallback to empty array
          setCollaborationParticipants([])
        }
      }
    }

    createParticipants()

    // Cleanup function to prevent state updates after unmount
    return () => {
      isMounted = false
    }
  }, [
    collaborationSessionEnabled,
    isGroupMode,
    groupAgents,
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
