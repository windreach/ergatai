import { useEffect, useMemo } from "react"
import { useAtom } from "jotai"

import { currentPlanPathAtomFamily } from "../atoms"
import { useAgentPlan } from "../hooks/use-agent-plan"

export function useActiveChatPlan({
  conversationId,
  parentChatId,
  status,
  isStreaming,
}: {
  conversationId: string
  parentChatId: string
  status: string
  isStreaming: boolean
}) {
  const currentPlanPathAtom = useMemo(
    () => currentPlanPathAtomFamily(conversationId),
    [conversationId],
  )

  const [, setCurrentPlanPath] = useAtom(currentPlanPathAtom)

  const {
    planPath: apiPlanPath,
    isLoading: planLoading,
    refetch: refetchPlan,
  } = useAgentPlan({
    chatId: parentChatId,
    conversationId,
    enabled: !!conversationId,
  })

  useEffect(() => {
    if (apiPlanPath) {
      setCurrentPlanPath(apiPlanPath)
    } else if (!planLoading) {
      setCurrentPlanPath(null)
    }
  }, [apiPlanPath, planLoading, setCurrentPlanPath])

  useEffect(() => {
    if (status === "ready" && !isStreaming && conversationId) {
      refetchPlan()
    }
  }, [status, isStreaming, conversationId, refetchPlan])

  useEffect(() => {
    const handlePlanUpdate = (event: Event) => {
      const customEvent = event as CustomEvent<{ conversationId: string; filePath: string }>
      if (customEvent.detail.conversationId === conversationId) {
        refetchPlan()
      }
    }

    window.addEventListener("plan-updated", handlePlanUpdate)
    return () => window.removeEventListener("plan-updated", handlePlanUpdate)
  }, [conversationId, refetchPlan])

  return {
    currentPlanPathAtom,
    setCurrentPlanPath,
    apiPlanPath,
    planLoading,
    refetchPlan,
  }
}
