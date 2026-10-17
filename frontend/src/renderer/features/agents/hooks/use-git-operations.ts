import { useCallback, useState } from "react"
import { useSetAtom } from "jotai"
import { toast } from "sonner"
import { trpcClient } from "../../../lib/trpc"
import {
  pendingPrMessageAtom,
  pendingReviewMessageAtom,
  pendingConflictResolutionMessageAtom,
} from "../../../lib/atoms"
import { useAgentConversationStore } from "../stores/conversation-store"
import { generatePrMessage, generateCommitToPrMessage, generateReviewMessage } from "../utils/pr-message"

interface UseGitOperationsOptions {
  worktreePath: string | null
  chatId: string | null
  activeConversationId: string | null
  setIsCreatingPr: (value: boolean) => void
  setIsReviewing: (value: boolean) => void
  setFilteredConversationId: (id: string) => void
  createPrMutation: any
}

export function useGitOperations({
  worktreePath,
  chatId,
  activeConversationId,
  setIsCreatingPr,
  setIsReviewing,
  setFilteredConversationId,
  createPrMutation,
}: UseGitOperationsOptions) {
  const setPendingPrMessage = useSetAtom(pendingPrMessageAtom)
  const setPendingReviewMessage = useSetAtom(pendingReviewMessageAtom)
  const setPendingConflictResolutionMessage = useSetAtom(pendingConflictResolutionMessageAtom)
  const [isCommittingToPr, setIsCommittingToPr] = useState(false)

  // Handle Create PR (Direct) - pushes branch and opens GitHub compare URL
  const handleCreatePrDirect = useCallback(async () => {
    if (!worktreePath) {
      toast.error("No workspace path available", { position: "top-center" })
      return
    }

    setIsCreatingPr(true)
    try {
      await createPrMutation.mutateAsync({ worktreePath })
    } finally {
      setIsCreatingPr(false)
    }
  }, [worktreePath, createPrMutation, setIsCreatingPr])

  // Handle Create PR with AI - sends a message to Claude to create the PR
  const handleCreatePr = useCallback(async () => {
    if (!chatId) {
      toast.error("Chat ID is required", { position: "top-center" })
      return
    }

    setIsCreatingPr(true)
    try {
      const activeConversationId = useAgentConversationStore.getState().activeConversationId
      if (!activeConversationId) {
        toast.error("No active chat available", { position: "top-center" })
        setIsCreatingPr(false)
        return
      }

      // Ensure the target conversation is focused before sending
      const store = useAgentConversationStore.getState()
      store.addToOpenConversations(activeConversationId)
      store.setActiveConversation(activeConversationId)

      // Get PR context from backend
      const context = await trpcClient.chats.getPrContext.query({ chatId })
      if (!context) {
        toast.error("Could not get git context", { position: "top-center" })
        setIsCreatingPr(false)
        return
      }

      // Generate message and set it for ChatViewInner to send
      const message = generatePrMessage(context)
      setPendingPrMessage({ message, conversationId: activeConversationId })
      // Don't reset isCreatingPr here - it will be reset after message is sent
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to prepare PR request",
        { position: "top-center" },
      )
      setIsCreatingPr(false)
    }
  }, [chatId, setPendingPrMessage, setIsCreatingPr])

  // Handle Commit to existing PR - sends a message to Claude to commit and push
  const handleCommitToPr = useCallback(async (_selectedPaths?: string[]) => {
    if (!chatId) {
      toast.error("Chat ID is required", { position: "top-center" })
      return
    }

    try {
      setIsCommittingToPr(true)
      const activeConversationId = useAgentConversationStore.getState().activeConversationId
      if (!activeConversationId) {
        toast.error("No active chat available", { position: "top-center" })
        setIsCommittingToPr(false)
        return
      }

      // Ensure the target conversation is focused before sending
      const store = useAgentConversationStore.getState()
      store.addToOpenConversations(activeConversationId)
      store.setActiveConversation(activeConversationId)

      const context = await trpcClient.chats.getPrContext.query({ chatId })
      if (!context) {
        toast.error("Could not get git context", { position: "top-center" })
        return
      }

      const message = generateCommitToPrMessage(context)
      setPendingPrMessage({ message, conversationId: activeConversationId })
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to prepare commit request",
        { position: "top-center" },
      )
    } finally {
      setIsCommittingToPr(false)
    }
  }, [chatId, setPendingPrMessage])

  // Handle Review - sends a message to Claude to review the diff
  const handleReview = useCallback(async () => {
    if (!chatId) {
      toast.error("Chat ID is required", { position: "top-center" })
      return
    }

    setIsReviewing(true)
    try {
      // Get PR context from backend
      const context = await trpcClient.chats.getPrContext.query({ chatId })
      if (!context) {
        toast.error("Could not get git context", { position: "top-center" })
        return
      }

      // Set filter to show only files from the active conversation
      if (activeConversationId) {
        setFilteredConversationId(activeConversationId)
      }

      // Generate review message and set it for ChatViewInner to send
      const message = generateReviewMessage(context)
      if (activeConversationId) {
        setPendingReviewMessage({ message, conversationId: activeConversationId })
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to start review",
        { position: "top-center" },
      )
    } finally {
      setIsReviewing(false)
    }
  }, [chatId, activeConversationId, setPendingReviewMessage, setFilteredConversationId, setIsReviewing])

  // Handle Fix Conflicts - sends a message to Claude to sync with main and fix merge conflicts
  const handleFixConflicts = useCallback(() => {
    const message = `This PR has merge conflicts with the main branch. Please:

1. First, fetch and merge the latest changes from main branch using git commands
2. If there are any merge conflicts, resolve them carefully by keeping the correct code from both branches
3. After resolving conflicts, commit the merge
4. Push the changes to update the PR

Make sure to preserve all functionality from both branches when resolving conflicts.`

    if (activeConversationId) {
      setPendingConflictResolutionMessage({ message, conversationId: activeConversationId })
    }
  }, [activeConversationId, setPendingConflictResolutionMessage])

  return {
    handleCreatePrDirect,
    handleCreatePr,
    handleCommitToPr,
    handleReview,
    handleFixConflicts,
    isCommittingToPr,
  }
}
