import { useCallback, useEffect, useMemo, useState } from "react"
import { trpc } from "../../../lib/trpc"
import { useAgentParticipants } from "../collaboration/use-agent-participants"
import { useImplicitCollaborationTasks } from "../collaboration/use-implicit-collaboration-tasks"
import { loadGroupAgents } from "../collaboration/group-agent-storage"
import type { CoreAgentOption } from "../lib/agent-contract-api"

export function useActiveChatCollaboration({
  isGroupMode,
  parentChatId,
  projectPath,
  workspaceId,
  provider,
  conversationId,
  isActive,
  isSplitPane,
}: {
  isGroupMode: boolean
  parentChatId: string
  projectPath: string | null | undefined
  workspaceId: string | null | undefined
  provider: string
  conversationId: string
  isActive: boolean
  isSplitPane: boolean
}) {  const [groupAgents, setGroupAgents] = useState<CoreAgentOption[]>([])

  useEffect(() => {
    setGroupAgents(isGroupMode ? loadGroupAgents(parentChatId) : [])
  }, [isGroupMode, parentChatId])

  const handleGroupAgentsChange = useCallback((agents: CoreAgentOption[]) => {
    setGroupAgents(agents)
  }, [])

  const groupContextValue = useMemo(
    () => ({ agents: groupAgents, isGroupChat: isGroupMode }),
    [groupAgents, isGroupMode],
  )

  const isVisiblePane = isActive || isSplitPane

  const agentParticipants = useAgentParticipants({
    chatId: parentChatId,
    workspaceId: projectPath || null,
    runtimeWorkspaceId: workspaceId || null,
    supervisorAgentId: isGroupMode ? null : provider,
  })

  const implicitCollaborationTasks = useImplicitCollaborationTasks(conversationId)

  const agentBindingsQuery = trpc.ergatai.getAgentBindings.useQuery(
    { chatId: parentChatId },
    { enabled: isVisiblePane && parentChatId.startsWith("chat_") },
  )

  return {
    groupAgents,
    setGroupAgents,
    handleGroupAgentsChange,
    groupContextValue,
    agentParticipants,
    implicitCollaborationTasks,
    agentBindingsQuery,
    isVisiblePane,
  }
}
