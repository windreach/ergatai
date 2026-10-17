import { trpc } from "../../../lib/trpc"

interface UseAgentPlanOptions {
  chatId: string | null
  conversationId: string | null
  enabled?: boolean
}

interface UseAgentPlanResult {
  planPath: string | null
  planContent: string | null
  isLoading: boolean
  error: any | null
  refetch: () => void
}

/**
 * Fetch plan for active conversation using backend API.
 * Uses getAgentBindings to find the agent for the conversation,
 * then calls getAgentPlan to fetch plan data.
 */
export function useAgentPlan({
  chatId,
  conversationId,
  enabled = true,
}: UseAgentPlanOptions): UseAgentPlanResult {
  // Step 1: Get agent bindings for this chat
  const {
    data: bindings,
    isLoading: bindingsLoading,
    error: bindingsError,
  } = trpc.ergatai.getAgentBindings.useQuery(
    { chatId: chatId! },
    { enabled: !!chatId && enabled }
  )

  // Step 2: Find binding for active conversation
  const activeBinding = bindings?.find((b) => b.conversationId === conversationId)
  const agentId = activeBinding?.agentId ?? null

  // Step 3: Fetch plan using agentId
  const {
    data: planData,
    isLoading: planLoading,
    error: planError,
    refetch,
  } = trpc.ergatai.getAgentPlan.useQuery(
    { agentId: agentId! },
    {
      enabled: !!agentId && enabled,
      retry: 1,
      staleTime: 5000, // Refetch after 5s
    }
  )

  const planPath = planData?.file_path ?? null
  const planContent = planData?.content ?? null

  return {
    planPath,
    planContent,
    isLoading: bindingsLoading || planLoading,
    error: bindingsError || planError || null,
    refetch,
  }
}
