import i18n from "@/lib/i18n"
"use client"

import { memo } from "react"
import { TextShimmer } from "../../../components/ui/text-shimmer"
import { QuestionIcon } from "../../../components/ui/icons"

type QuestionOption = {
  label: string
  description?: string
}

type QuestionInput = {
  question: string
  header?: string
  multiple?: boolean
  options?: QuestionOption[]
}

interface AgentQuestionToolProps {
  input?: {
    questions?: QuestionInput[]
  }
  output?: unknown
  errorText?: string
  state: "call" | "result"
  isError?: boolean
  isStreaming?: boolean
}

function StatusLine({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 py-1 px-2 text-xs text-muted-foreground">
      {children}
    </div>
  )
}

function extractAnswers(output: unknown): string[][] | null {
  if (!output || typeof output !== "object") return null

  const record = output as Record<string, unknown>
  const metadata =
    record.metadata && typeof record.metadata === "object"
      ? (record.metadata as Record<string, unknown>)
      : undefined
  const answers = metadata?.answers ?? record.answers
  if (!Array.isArray(answers)) return null

  return answers.map((answer) => {
    if (Array.isArray(answer)) return answer.map((value) => String(value))
    if (answer == null) return []
    return [String(answer)]
  })
}

function friendlyError(errorText?: string): string {
  if (!errorText) return "Failed"
  if (errorText.includes("couldn't be shown")) {
    return "Couldn't show question in this client"
  }
  return errorText
}

export const AgentQuestionTool = memo(function AgentQuestionTool({
  input,
  output,
  errorText,
  state,
  isError,
  isStreaming,
}: AgentQuestionToolProps) {
  const questions = input?.questions ?? []
  const firstQuestion = questions[0]?.header || questions[0]?.question
  const answers = extractAnswers(output)

  if (isError) {
    return (
      <StatusLine>
        <QuestionIcon className="w-3.5 h-3.5" />
        <span>{firstQuestion || i18n.t("Question")}</span>
        <span className="text-muted-foreground/50">•</span>
        <span className="text-red-500">{friendlyError(errorText)}</span>
      </StatusLine>
    )
  }

  if (state === "call") {
    return (
      <StatusLine>
        <QuestionIcon className="w-3.5 h-3.5" />
        <span>{firstQuestion || i18n.t("Question")}</span>
        <span className="text-muted-foreground/50">•</span>
        {isStreaming ? (
          <TextShimmer as="span" duration={1.2}>
            Asking question...
          </TextShimmer>
        ) : (
          <span>{i18n.t("Interrupted")}</span>
        )}
      </StatusLine>
    )
  }

  if (!answers) {
    return (
      <StatusLine>
        <QuestionIcon className="w-3.5 h-3.5" />
        <span>{i18n.t("Question answered")}</span>
      </StatusLine>
    )
  }

  return (
    <div className="rounded-lg border border-border bg-muted/30 overflow-hidden mx-2">
      <div className="flex items-center gap-1.5 pl-2.5 pr-2 h-7 border-b border-border">
        <QuestionIcon className="w-3.5 h-3.5 text-muted-foreground" />
        <span className="text-xs text-muted-foreground">
          {questions.length === 1 ? "Answer" : "Answers"}
        </span>
      </div>
      <div className="flex flex-col gap-2 p-2.5 text-xs">
        {questions.length > 0
          ? questions.map((question, index) => (
              // react-doctor-disable-next-line no-array-index-as-key
              <div key={`${question.question}-${index}`} className="flex flex-col gap-0.5">
                <span className="font-medium text-foreground">
                  {question.question}
                </span>
                <span className="text-muted-foreground">
                  {answers[index]?.join(", ") || "(no answer)"}
                </span>
              </div>
            ))
          : answers.map((answer, index) => (
              // react-doctor-disable-next-line no-array-index-as-key
              <div key={`answer-${index}`} className="flex flex-col gap-0.5">
                <span className="text-muted-foreground">
                  {answer.join(", ") || "(no answer)"}
                </span>
              </div>
            ))}
      </div>
    </div>
  )
})
