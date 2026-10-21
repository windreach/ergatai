import { useCallback, useRef, useMemo } from "react"
import { trpcClient } from "../../../lib/trpc"

interface UseQuestionAnswersOptions {
  displayQuestions: any
  isQuestionExpired: boolean
  conversationId: string
  editorRef: React.RefObject<any>
  questionRef: React.RefObject<any>
  clearPendingQuestionCallback: () => void
  clearInputAndDraft: () => void
  sendUserMessage: (text: string) => Promise<void>
  isStreamingRef: React.RefObject<boolean>
  stopRef: React.RefObject<() => Promise<void>>
  agentChatStore: any
}

const QUESTIONS_SKIPPED_MESSAGE = "User skipped answering the questions"

export function useQuestionAnswers({
  displayQuestions,
  isQuestionExpired,
  conversationId,
  editorRef,
  questionRef,
  clearPendingQuestionCallback,
  clearInputAndDraft,
  sendUserMessage,
  isStreamingRef,
  stopRef,
  agentChatStore,
}: UseQuestionAnswersOptions) {
  const formatAnswersAsText = useCallback(
    (answers: Record<string, string>): string =>
      Object.entries(answers)
        .map(([question, answer]) => `${question}: ${answer}`)
        .join("\n"),
    [],
  )

  // Handle answering questions
  const handleQuestionsAnswer = useCallback(
    async (answers: Record<string, string>) => {
      if (!displayQuestions) return

      if (isQuestionExpired) {
        // Question timed out - send answers as a normal user message
        clearPendingQuestionCallback()
        await sendUserMessage(formatAnswersAsText(answers))
      } else {
        // Question is still live - use tool approval path
        await trpcClient.mcp.respondToolApproval.mutate({
          toolUseId: displayQuestions.toolUseId,
          approved: true,
          updatedInput: { questions: displayQuestions.questions, answers },
        })
        clearPendingQuestionCallback()
      }
    },
    [displayQuestions, isQuestionExpired, clearPendingQuestionCallback, sendUserMessage, formatAnswersAsText],
  )

  // Handle skipping questions
  const handleQuestionsSkip = useCallback(async () => {
    if (!displayQuestions) return

    if (isQuestionExpired) {
      // Expired question - just clear the UI, no backend call needed
      clearPendingQuestionCallback()
      return
    }

    const toolUseId = displayQuestions.toolUseId

    // Clear UI immediately - don't wait for backend
    // This ensures dialog closes even if stream was already aborted
    clearPendingQuestionCallback()

    // Try to notify backend (may fail if already aborted - that's ok)
    try {
      await trpcClient.mcp.respondToolApproval.mutate({
        toolUseId,
        approved: false,
        message: QUESTIONS_SKIPPED_MESSAGE,
      })
    } catch {
      // Stream likely already aborted - ignore
    }
  }, [displayQuestions, isQuestionExpired, clearPendingQuestionCallback])

  // Ref to prevent double submit of question answer
  const isSubmittingQuestionAnswerRef = useRef(false)

  // Handle answering questions with custom text from input (called on Enter in input)
  const handleSubmitWithQuestionAnswer = useCallback(
    async () => {
      if (!displayQuestions) return
      if (isSubmittingQuestionAnswerRef.current) return
      isSubmittingQuestionAnswerRef.current = true

      try {
        // 1. Get custom text from input
        const customText = editorRef.current?.getValue()?.trim() || ""
        if (!customText) {
          isSubmittingQuestionAnswerRef.current = false
          return
        }

        // 2. Get already selected answers from question component
        const selectedAnswers = questionRef.current?.getAnswers() || {}
        const formattedAnswers: Record<string, string> = { ...selectedAnswers }

        // 3. Add custom text to the last question as "Other"
        const lastQuestion =
          displayQuestions.questions[displayQuestions.questions.length - 1]
        if (lastQuestion) {
          const existingAnswer = formattedAnswers[lastQuestion.question]
          if (existingAnswer) {
            // Append to existing answer
            formattedAnswers[lastQuestion.question] = `${existingAnswer}, Other: ${customText}`
          } else {
            formattedAnswers[lastQuestion.question] = `Other: ${customText}`
          }
        }

        if (isQuestionExpired) {
          // Expired: send user's custom text as-is (don't format)
          clearPendingQuestionCallback()
          clearInputAndDraft()
          // await sendUserMessage(formatAnswersAsText(formattedAnswers))
          await sendUserMessage(customText)
        } else {
          // Live: use existing tool approval flow
          await trpcClient.mcp.respondToolApproval.mutate({
            toolUseId: displayQuestions.toolUseId,
            approved: true,
            updatedInput: {
              questions: displayQuestions.questions,
              answers: formattedAnswers,
            },
          })
          clearPendingQuestionCallback()

          // Stop stream if currently streaming
          if (isStreamingRef.current) {
            agentChatStore.setManuallyAborted(conversationId, true)
            await stopRef.current()
            await new Promise((resolve) => setTimeout(resolve, 100))
          }

          clearInputAndDraft()
          await sendUserMessage(customText)
        }
      } finally {
        isSubmittingQuestionAnswerRef.current = false
      }
    },
    [displayQuestions, isQuestionExpired, clearPendingQuestionCallback, clearInputAndDraft, sendUserMessage, conversationId],
  )

  // Memoize the callback to prevent ChatInputArea re-renders
  // Only provide callback when there's a pending or expired question for this conversation
  const submitWithQuestionAnswerCallback = useMemo(
    () =>
      displayQuestions
        ? handleSubmitWithQuestionAnswer
        : undefined,
    [displayQuestions, handleSubmitWithQuestionAnswer],
  )

  return {
    formatAnswersAsText,
    handleQuestionsAnswer,
    handleQuestionsSkip,
    handleSubmitWithQuestionAnswer,
    submitWithQuestionAnswerCallback,
    isSubmittingQuestionAnswerRef,
  }
}
