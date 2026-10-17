import { useEffect, useMemo } from "react"
import { useSetAtom } from "jotai"
import { pendingPlanApprovalsAtom } from "../../../lib/atoms"

interface UseUnapprovedPlanDetectionOptions {
  messages: any[]
  conversationMode: "plan" | "agent"
  conversationId: string
  parentChatId: string | null
  isActive: boolean
  isStreaming: boolean
  hasUnapprovedPlanRef: React.RefObject<boolean>
  handleApprovePlan: () => void
}

export function useUnapprovedPlanDetection({
  messages,
  conversationMode,
  conversationId,
  parentChatId,
  isActive,
  isStreaming,
  hasUnapprovedPlanRef,
  handleApprovePlan,
}: UseUnapprovedPlanDetectionOptions) {
  // Check if there's an unapproved plan (in plan mode with completed ExitPlanMode)
  const hasUnapprovedPlan = useMemo(() => {
    // If already in agent mode, plan is approved (mode is the source of truth)
    if (conversationMode !== "plan") return false

    // Look for completed ExitPlanMode in messages
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]

      // If assistant message with completed ExitPlanMode, we found an unapproved plan
      if (msg.role === "assistant" && msg.parts) {
        const exitPlanPart = msg.parts.find(
          (p: any) => p.type === "tool-ExitPlanMode"
        )
        // Check if ExitPlanMode is completed (has output, even if empty)
        if (exitPlanPart && exitPlanPart.output !== undefined) {
          return true
        }
      }
    }
    return false
  }, [messages, conversationMode])

  // Keep ref in sync for use in initializeScroll (which runs in useLayoutEffect)
  hasUnapprovedPlanRef.current = hasUnapprovedPlan

  // Update pending plan approvals atom for sidebar indicators
  const setPendingPlanApprovals = useSetAtom(pendingPlanApprovalsAtom)
  useEffect(() => {
    setPendingPlanApprovals((prev: Map<string, string>) => {
      const newMap = new Map(prev)
      if (hasUnapprovedPlan && parentChatId) {
        newMap.set(conversationId, parentChatId)
      } else {
        newMap.delete(conversationId)
      }
      // Only return new map if it changed
      if (newMap.size !== prev.size || ![...newMap.keys()].every((id) => prev.has(id))) {
        return newMap
      }
      return prev
    })
  }, [hasUnapprovedPlan, conversationId, parentChatId, setPendingPlanApprovals])

  // Keyboard shortcut: Cmd+Enter to approve plan
  useEffect(() => {
    if (!isActive) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.key === "Enter" &&
        e.metaKey &&
        !e.shiftKey &&
        hasUnapprovedPlan &&
        !isStreaming
      ) {
        e.preventDefault()
        handleApprovePlan()
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [isActive, hasUnapprovedPlan, isStreaming, handleApprovePlan])

  return {
    hasUnapprovedPlan,
  }
}
