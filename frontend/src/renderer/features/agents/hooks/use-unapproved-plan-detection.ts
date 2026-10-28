import { useEffect, useLayoutEffect, useMemo } from "react"
import { useSetAtom } from "jotai"
import { pendingPlanApprovalsAtom } from "../../../lib/atoms"
import type { Message, MessagePart } from "../stores/message-store"

interface UseUnapprovedPlanDetectionOptions {
  messages: Message[]
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
          (p: MessagePart) => p.type === "tool-ExitPlanMode"
        )
        // Check if ExitPlanMode is completed (has output, even if empty)
        if (exitPlanPart && exitPlanPart.output !== undefined) {
          return true
        }
      }
    }
    return false
  }, [messages, conversationMode])

  // Keep ref in sync for use in initializeScroll (which runs in useLayoutEffect).
  // Synchronize via useLayoutEffect so the ref is consistent before the browser paints,
  // avoiding unsafe ref mutations during the render phase (which React may interrupt).
  useLayoutEffect(() => {
    hasUnapprovedPlanRef.current = hasUnapprovedPlan
  }, [hasUnapprovedPlan, hasUnapprovedPlanRef])

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
      // Only return new map if keys OR values changed (e.g., a conversation's parentChatId moved)
      if (
        newMap.size !== prev.size ||
        ![...newMap.entries()].every(([id, val]) => prev.get(id) === val)
      ) {
        return newMap
      }
      return prev
    })
  }, [hasUnapprovedPlan, conversationId, parentChatId, setPendingPlanApprovals])

  // Keyboard shortcut: Cmd+Enter (macOS) or Ctrl+Enter (Windows/Linux) to approve plan
  useEffect(() => {
    if (!isActive) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.key === "Enter" &&
        (e.metaKey || e.ctrlKey) &&
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
