import { useCallback } from "react"
import { trpcClient } from "../../../lib/trpc"
import { toast } from "sonner"
import { useAgentConversationStore } from "../stores/conversation-store"

// Hardcoded business string for plan approval
const IMPLEMENT_PLAN_MESSAGE = "Implement plan"

interface UsePlanApprovalOptions {
  conversationId: string
  setConversationMode: (mode: "plan" | "agent") => void
  scrollToBottom: () => void
  updateConversationModeMutation: {
    mutate: (vars: { conversationId: string; mode: "agent" | "plan" }) => void
  }
  sendMessageRef: React.RefObject<(message: { role: string; parts: Array<{ type: string; text?: string }> }) => Promise<void>>
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

  // Handle plan approval - sends "Implement plan" message and switches to agent mode
  // NOTE: Direct store access is intentional - the transport reads from store synchronously.
  // If subsequent steps fail, the store will be in "agent" mode but the message won't be sent.
  // This is an acceptable trade-off since the user can manually switch back to plan mode.
  const handleApprovePlan = useCallback(
    async () => {
      // Update store mode synchronously BEFORE sending (transport reads from store)
      useAgentConversationStore.getState().updateConversationMode(conversationId, "agent")

      // Sync mode to database for sidebar indicator (getPendingPlanApprovals)
      if (!conversationId.startsWith("temp-")) {
        updateConversationModeMutation.mutate({ conversationId, mode: "agent" })
      }

      // Update atomFamily state (for UI) - this also syncs to store via effect
      setConversationMode("agent")

      // Enable auto-scroll and immediately scroll to bottom
      scrollToBottom()

      // Send "Implement plan" message (now in agent mode)
      if (!sendMessageRef.current) {
        console.error("[plan-approval] sendMessageRef.current is not available")
        toast.error("Message system is not ready. Please try again.")
        return
      }

      try {
        await sendMessageRef.current({
          role: "user",
          parts: [{ type: "text", text: IMPLEMENT_PLAN_MESSAGE }],
        })
      } catch (error) {
        console.error("[plan-approval] Failed to send message:", error)
        toast.error("Failed to send implementation request. Please try again.")
      }
    },
    [conversationId, setConversationMode, scrollToBottom, updateConversationModeMutation, sendMessageRef],
  )

  return {
    handlePlanApproval,
    handleApprovePlan,
  }
}
