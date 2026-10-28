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
  error: Error | null
  refetch: () => void
  refetchBindings: () => void
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
    refetch: refetchBindings,
  } = trpc.ergatai.getAgentBindings.useQuery(
    { chatId: chatId ?? '' },
    { enabled: !!chatId && enabled }
  )

  // Step 2: Find binding for active conversation
  const activeBinding = conversationId
    ? bindings?.find((b) => b.conversationId === conversationId)
    : undefined
  const agentId = activeBinding?.agentId ?? null

  // Step 3: Fetch plan using agentId
  const {
    data: planData,
    isLoading: planLoading,
    error: planError,
    refetch,
  } = trpc.ergatai.getAgentPlan.useQuery(
    { agentId: agentId ?? '' },
    {
      enabled: !!agentId && enabled,
      retry: 1,
      staleTime: 5000, // Refetch after 5s
    }
  )

  const planPath = planData?.file_path ?? null
  const planContent = planData?.content ?? null

  // Convert TRPC errors to standard Error objects
  const error = bindingsError || planError
    ? new Error((bindingsError || planError)?.message ?? "Unknown error")
    : null

  return {
    planPath,
    planContent,
    isLoading: bindingsLoading || planLoading,
    error,
    refetch,
    refetchBindings,
  }
}
