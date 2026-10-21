import { useCallback } from "react"
import { trpcClient } from "../../../lib/trpc"
import { toast } from "sonner"
import { useAgentConversationStore } from "../stores/conversation-store"

interface UsePlanApprovalOptions {
  conversationId: string
  setConversationMode: (mode: "plan" | "agent") => void
  scrollToBottom: () => void
  updateConversationModeMutation: any
  sendMessageRef: React.RefObject<(message: any) => Promise<void>>
}

export function usePlanApproval({
  conversationId,
  setConversationMode,
  scrollToBottom,
  updateConversationModeMutation,
  sendMessageRef,
}: UsePlanApprovalOptions) {
  const handlePlanApproval = useCallback(
    async (toolUseId: string, approved: boolean) => {
      if (!toolUseId) return

      // This would need planApprovalPending state passed in or managed here
      // For now, we'll just handle the API call
      try {
        await trpcClient.mcp.respondToolApproval.mutate({
          toolUseId,
          approved,
        })
      } catch (error) {
        console.error("[plan-approval] Failed to respond:", error)
        toast.error("Failed to send plan approval. Please try again.")
      }
    },
    [],
  )

  // Handle plan approval - sends "Build plan" message and switches to agent mode
  const handleApprovePlan = useCallback(() => {
    // Update store mode synchronously BEFORE sending (transport reads from store)
    useAgentConversationStore.getState().updateConversationMode(conversationId, "agent")

    // Sync mode to database for sidebar indicator (getPendingPlanApprovals)
    if (!conversationId.startsWith("temp-")) {
      updateConversationModeMutation.mutate({ conversationId, mode: "agent" })
    }

    // Update atomFamily state (for UI) - this also syncs to store via effect
    setConversationMode("agent")

    // Enable auto-scroll and immediately scroll to bottom
    // Note: shouldAutoScrollRef needs to be passed in or managed differently
    // For now, we'll just call scrollToBottom
    scrollToBottom()

    // Send "Build plan" message (now in agent mode)
    sendMessageRef.current({
      role: "user",
      parts: [{ type: "text", text: "Implement plan" }],
    })
  }, [conversationId, setConversationMode, scrollToBottom, updateConversationModeMutation, sendMessageRef])

  return {
    handlePlanApproval,
    handleApprovePlan,
  }
}
