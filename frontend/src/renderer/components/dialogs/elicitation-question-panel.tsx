import type { PendingUserQuestions } from "../../features/agents/atoms"
import { AgentUserQuestion } from "../../features/agents/ui/agent-user-question"
import { trpc } from "../../lib/trpc"
import { toast } from "sonner"
import {
  buildElicitationFormData,
  type PendingElicitation,
} from "./elicitation-form"

export function ElicitationQuestionPanel({
  elicitation,
  conversationId,
  chatId,
  onResolved,
}: {
  elicitation: PendingElicitation
  conversationId: string
  chatId: string
  onResolved?: (requestId: string) => void
}) {
  const utils = trpc.useUtils()
  const respondPermissionMutation = trpc.ergatai.respondPermission.useMutation()

  const resolve = async (
    approved: boolean,
    formData?: Record<string, unknown>,
  ) => {
    try {
      await respondPermissionMutation.mutateAsync({
        requestId: elicitation.request.requestId,
        decision: approved ? "allow_once" : "reject_once",
        formData,
      })
      onResolved?.(elicitation.request.requestId)
      await utils.ergatai.getPendingPermissions.invalidate()
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to respond"
      toast.error(message)
      throw error
    }
  }

  const pendingQuestions: PendingUserQuestions = {
    conversationId,
    parentChatId: chatId,
    toolUseId: elicitation.request.requestId,
    questions: elicitation.questions.map((question) => ({
      question: question.question,
      header: question.header,
      options: question.options,
      multiSelect: question.multiSelect,
    })),
  }

  return (
    <AgentUserQuestion
      key={elicitation.request.requestId}
      pendingQuestions={pendingQuestions}
      onAnswer={() => {}}
      onSkip={() => resolve(false)}
      answerKeys={elicitation.questions.map((question) => question.key)}
      onStructuredAnswer={(answers) =>
        resolve(true, buildElicitationFormData(elicitation, answers))
      }
    />
  )
}
