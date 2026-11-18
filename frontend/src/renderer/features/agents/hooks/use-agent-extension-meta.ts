import i18n from "@/lib/i18n"
import { trpc } from "../../../lib/trpc"

interface UseAgentExtensionMetaOptions {
  agentId: string | null
  enabled?: boolean
}

/**
 * Fetch the latest parsed ACP extension metadata for an agent.
 * Returns the raw backend payload (already normalized by Rust).
 */
export function useAgentExtensionMeta({
  agentId,
  enabled = true,
}: UseAgentExtensionMetaOptions) {
  const query = trpc.ergatai.getAgentExtensionMeta.useQuery(
    { agentId: agentId ?? "" },
    {
      enabled: !!agentId && enabled,
      retry: 1,
      staleTime: 5000,
    }
  )

  return {
    agentId: query.data?.agent_id ?? agentId,
    extensionMeta: query.data?.extension_meta ?? null,
    isLoading: query.isLoading,
    error: query.error
      ? new Error(query.error.message ?? i18n.t('Unknown error'))
      : null,
    refetch: query.refetch,
  }
}