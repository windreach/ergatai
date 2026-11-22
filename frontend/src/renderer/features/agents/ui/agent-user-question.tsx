// Modified from 1Code (Apache-2.0) by Ergatai — see MODIFICATIONS.md
import i18n from "@/lib/i18n"
"use client"

import { memo, useState, useEffect, useCallback, useRef, forwardRef, useImperativeHandle, useMemo } from "react"
import { ChevronUp, ChevronDown, CornerDownLeft } from "lucide-react"
import { Button } from "../../../components/ui/button"
import { cn } from "../../../lib/utils"
import type { PendingUserQuestions } from "../atoms"
import { useAgentQuestionKeyboard } from "./use-agent-question-keyboard"

interface AgentUserQuestionProps {
  pendingQuestions: PendingUserQuestions
  onAnswer: (answers: Record<string, string>) => void
  onSkip: () => void | Promise<void>
  hasCustomText?: boolean
  /**
   * Stable keys used for structured submissions (e.g. OpenCode form fields
   * `q0`, `q1`). When omitted, the question text is used as the key.
   */
  answerKeys?: string[]
  /**
   * When provided, submissions are returned keyed by `answerKeys` (or question
   * text) so callers can forward them to non-Claude backends such as ACP form
   * elicitations. `onAnswer` is then ignored.
   */
  onStructuredAnswer?: (answers: Record<string, string[]>) => void | Promise<void>
}

export interface AgentUserQuestionHandle {
  getAnswers: () => Record<string, string>
}

// react-doctor-disable-next-line no-giant-component
export const AgentUserQuestion = memo(forwardRef<AgentUserQuestionHandle, AgentUserQuestionProps>(
  // react-doctor-disable-next-line no-high-complexity-react-function
  function AgentUserQuestion({
    pendingQuestions,
    onAnswer,
    onSkip,
    hasCustomText = false,
    answerKeys,
    onStructuredAnswer,
  }: AgentUserQuestionProps, ref) {
  const { questions, toolUseId } = pendingQuestions
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0)
  const [answers, setAnswers] = useState<Record<string, string[]>>({})
  const [customAnswers, setCustomAnswers] = useState<Record<string, string>>({})
  const [focusedOptionIndex, setFocusedOptionIndex] = useState(0)
  const [isCustomInputFocused, setIsCustomInputFocused] = useState(false)
  const [isVisible, setIsVisible] = useState(true)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const prevIndexRef = useRef(currentQuestionIndex)
  const prevToolUseIdRef = useRef(toolUseId)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const answerKeyFor = useCallback(
    (question: { question: string }, index: number) =>
      answerKeys?.[index] ?? question.question,
    [answerKeys],
  )

  const combineAnswers = useCallback(
    (question: { question: string }, index: number): string[] => {
      const key = answerKeyFor(question, index)
      const selected = [...(answers[key] ?? [])]
      const custom = (customAnswers[key] ?? "").trim()
      if (custom && !selected.includes(custom)) {
        selected.push(custom)
      }
      return selected
    },
    [answerKeyFor, answers, customAnswers],
  )

  // Helper function to format answers for Claude's tool-approval payload.
  const formatAnswers = useCallback(() => {
    const formatted: Record<string, string> = {}
    questions.forEach((question, index) => {
      const combined = combineAnswers(question, index)
      if (combined.length > 0) {
        formatted[question.question] = combined.join(", ")
      }
    })
    return formatted
  }, [questions, combineAnswers])

  // Helper function to format answers for ACP form elicitations.
  const formatStructuredAnswers = useCallback(() => {
    const structured: Record<string, string[]> = {}
    questions.forEach((question, index) => {
      const key = answerKeyFor(question, index)
      const combined = combineAnswers(question, index)
      if (combined.length > 0) {
        structured[key] = combined
      }
    })
    return structured
  }, [questions, answerKeyFor, combineAnswers])

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
      }
    }
  }, [])

  // Expose getAnswers method to parent via ref
  useImperativeHandle(ref, () => ({
    getAnswers: formatAnswers,
  }), [formatAnswers])

  // Reset when toolUseId changes (new question set)
  useEffect(() => {
    if (prevToolUseIdRef.current !== toolUseId) {
      // react-doctor-disable-next-line no-adjust-state-on-prop-change
      setIsSubmitting(false)
      // react-doctor-disable-next-line no-adjust-state-on-prop-change
      setCurrentQuestionIndex(0)
      // react-doctor-disable-next-line no-adjust-state-on-prop-change
      setAnswers({})
      // react-doctor-disable-next-line no-adjust-state-on-prop-change
      setCustomAnswers({})
      // react-doctor-disable-next-line no-adjust-state-on-prop-change
      setFocusedOptionIndex(0)
      // react-doctor-disable-next-line no-adjust-state-on-prop-change
      setIsCustomInputFocused(false)
      prevToolUseIdRef.current = toolUseId
    }
  }, [toolUseId])

  // Animate on question change - using key prop on container for clean remount
  useEffect(() => {
    if (prevIndexRef.current !== currentQuestionIndex) {
      setIsVisible(false)
      // Use requestAnimationFrame for smoother animation
      const rafId = requestAnimationFrame(() => {
        setIsVisible(true)
      })
      prevIndexRef.current = currentQuestionIndex
      return () => cancelAnimationFrame(rafId)
    }
  }, [currentQuestionIndex])

  const currentQuestion = questions[currentQuestionIndex]
  const currentOptions = useMemo(() => currentQuestion?.options || [], [currentQuestion?.options])
  const currentAnswerKey = currentQuestion
    ? answerKeyFor(currentQuestion, currentQuestionIndex)
    : ""
  const currentSelectedAnswers = answers[currentAnswerKey] ?? []
  const currentCustomAnswer = customAnswers[currentAnswerKey] ?? ""
  const isCustomSelected = currentCustomAnswer.trim().length > 0
  const currentQuestionHasAnswer =
    currentSelectedAnswers.length > 0 || isCustomSelected

  const isOptionSelected = (questionIndex: number, optionLabel: string) => {
    const question = questions[questionIndex]
    if (!question) return false
    const key = answerKeyFor(question, questionIndex)
    return answers[key]?.includes(optionLabel) || false
  }

  // Handle option click - auto-advance for single-select questions
  const handleOptionClick = useCallback(
    (optionLabel: string, questionIndex: number) => {
      const question = questions[questionIndex]
      if (!question) return
      const key = answerKeyFor(question, questionIndex)
      const allowMultiple = question.multiSelect || false
      const isLastQuestion = questionIndex === questions.length - 1

      if (!allowMultiple) {
        // Selecting a predefined option clears a custom answer.
        setCustomAnswers((prev) => {
          if (!prev[key]) return prev
          const next = { ...prev }
          next[key] = ""
          return next
        })
      }

      setAnswers((prev) => {
        const currentAnswers = prev[key] || []

        if (allowMultiple) {
          if (currentAnswers.includes(optionLabel)) {
            return {
              ...prev,
              [key]: currentAnswers.filter((l) => l !== optionLabel),
            }
          } else {
            return {
              ...prev,
              [key]: [...currentAnswers, optionLabel],
            }
          }
        } else {
          return {
            ...prev,
            [key]: [optionLabel],
          }
        }
      })

      // For single-select questions, auto-advance to next question
      if (!allowMultiple && !isLastQuestion) {
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current)
        }
        timeoutRef.current = setTimeout(() => {
          setCurrentQuestionIndex(questionIndex + 1)
          setFocusedOptionIndex(0)
          timeoutRef.current = null
        }, 150)
      }
    },
    [answerKeyFor, questions],
  )

  const handlePrevious = () => {
    if (currentQuestionIndex > 0) {
      setCurrentQuestionIndex(currentQuestionIndex - 1)
      setFocusedOptionIndex(0)
    }
  }

  const handleNext = () => {
    if (currentQuestionIndex < questions.length - 1) {
      setCurrentQuestionIndex(currentQuestionIndex + 1)
      setFocusedOptionIndex(0)
    }
  }

  const handleContinue = useCallback(() => {
    if (isSubmitting) return
    if (!currentQuestionHasAnswer) return

    if (currentQuestionIndex < questions.length - 1) {
      setCurrentQuestionIndex(currentQuestionIndex + 1)
      setFocusedOptionIndex(0)
      return
    }

    // On the last question, validate ALL questions are answered before submit
    const allAnswered = questions.every((question, index) => {
      const key = answerKeyFor(question, index)
      return (
        (answers[key] ?? []).length > 0 ||
        (customAnswers[key] ?? "").trim().length > 0
      )
    })
    if (!allAnswered) return

    setIsSubmitting(true)
    if (onStructuredAnswer) {
      try {
        void Promise.resolve(onStructuredAnswer(formatStructuredAnswers())).catch(() => {
          setIsSubmitting(false)
        })
      } catch {
        setIsSubmitting(false)
      }
      return
    }
    onAnswer(formatAnswers())
  }, [
    onAnswer,
    onStructuredAnswer,
    answerKeyFor,
    answers,
    customAnswers,
    currentQuestionHasAnswer,
    currentQuestionIndex,
    questions,
    isSubmitting,
    formatAnswers,
    formatStructuredAnswers,
  ])

  const handleSkipWithGuard = useCallback(() => {
    if (isSubmitting) return
    setIsSubmitting(true)
    void (async () => {
      try {
        await onSkip()
      } catch {
        setIsSubmitting(false)
      }
    })()
  }, [isSubmitting, onSkip])

  const getOptionNumber = (index: number) => {
    return String(index + 1)
  }

  const handleCustomAnswerChange = useCallback(
    (value: string) => {
      const key = currentAnswerKey
      if (!key) return
      setCustomAnswers((prev) => ({ ...prev, [key]: value }))
      // For single-select questions a custom answer replaces the selection.
      if (!currentQuestion?.multiSelect) {
        setAnswers((prev) => {
          if ((prev[key] ?? []).length === 0) return prev
          return { ...prev, [key]: [] }
        })
      }
    },
    [currentAnswerKey, currentQuestion?.multiSelect],
  )

  const allQuestionsAnswered = questions.every((question, index) => {
    const key = answerKeyFor(question, index)
    return (
      (answers[key] ?? []).length > 0 ||
      (customAnswers[key] ?? "").trim().length > 0
    )
  })
  const isLastQuestion = currentQuestionIndex === questions.length - 1

  useAgentQuestionKeyboard({
    containerRef,
    isSubmitting,
    focusedOptionIndex,
    currentOptions,
    questions,
    currentQuestionIndex,
    currentQuestionHasAnswer,
    setFocusedOptionIndex,
    setCurrentQuestionIndex,
    handleOptionClick,
    handleContinue,
  })

  if (questions.length === 0) {
    return null
  }

  return (
    <div ref={containerRef} className="border rounded-t-xl border-b-0 border-border bg-muted/30 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5">
        <div className="flex items-center gap-1.5">
          <span className="text-[12px] text-muted-foreground">
            {currentQuestion?.header || "Question"}
          </span>
          <span className="text-muted-foreground/50">•</span>
          <span className="text-[12px] text-muted-foreground">
            {currentQuestion?.multiSelect ? "Multi-select" : "Single-select"}
          </span>
        </div>

        {/* Navigation */}
        {questions.length > 1 && (
          <div className="flex items-center gap-1">
            <button
              aria-label={i18n.t('ChevronUp')}
              onClick={handlePrevious}
              disabled={currentQuestionIndex === 0}
              className="p-0.5 rounded hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed outline-none"
            >
              <ChevronUp className="w-4 h-4 text-muted-foreground" />
            </button>
            <span className="text-xs text-muted-foreground px-1">
              {currentQuestionIndex + 1} / {questions.length}
            </span>
            <button
              aria-label={i18n.t('ChevronDown')}
              onClick={handleNext}
              disabled={currentQuestionIndex === questions.length - 1}
              className="p-0.5 rounded hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed outline-none"
            >
              <ChevronDown className="w-4 h-4 text-muted-foreground" />
            </button>
          </div>
        )}
      </div>

      {/* Current Question */}
      <div
        key={currentQuestionIndex}
        className={cn(
          "px-1 pb-2 transition-opacity duration-150 ease-out",
          isVisible ? "opacity-100" : "opacity-0",
        )}
      >
        <div className="text-[14px] font-[450] text-foreground mb-3 pt-1 px-2">
          <span className="text-muted-foreground">{currentQuestionIndex + 1}.</span> {currentQuestion?.question}
        </div>

        {/* Options */}
        <div className="space-y-1">
          {currentOptions.map((option, optIndex) => {
            const isSelected = isOptionSelected(currentQuestionIndex, option.label)
            // The focus ring is a keyboard-navigation hint, not a selection.
            // Hide it while the custom answer is active or being typed so it
            // can't be mistaken for a selected option.
            const isFocused =
              focusedOptionIndex === optIndex &&
              !isCustomInputFocused &&
              !isCustomSelected
            const number = getOptionNumber(optIndex)

            return (
              <button
                key={option.label}
                onClick={() => {
                  if (isSubmitting) return
                  handleOptionClick(option.label, currentQuestionIndex)
                  setFocusedOptionIndex(optIndex)
                }}
                disabled={isSubmitting}
                className={cn(
                  "w-full flex items-start gap-3 p-2 text-[13px] text-foreground rounded-md text-left transition-colors outline-none",
                  isFocused ? "bg-muted/70" : "hover:bg-muted/50",
                  isSubmitting && "opacity-50 cursor-not-allowed",
                )}
              >
                <div
                  className={cn(
                    "flex-shrink-0 w-5 h-5 rounded flex items-center justify-center text-[10px] font-medium transition-colors mt-0.5",
                    isSelected
                      ? "bg-foreground text-background"
                      : "bg-muted text-muted-foreground",
                  )}
                >
                  {number}
                </div>
                <div className="flex flex-col gap-0.5">
                  <span className="text-[13px] transition-colors font-medium text-foreground">
                    {option.label}
                  </span>
                  {option.description && (
                    <span className="text-[12px] text-muted-foreground">
                      {option.description}
                    </span>
                  )}
                </div>
              </button>
            )
          })}
        </div>
      </div>

      {/* Custom answer (free text) */}
      <div className="px-2 pb-2">
        <div
          className={cn(
            "flex items-center gap-2 rounded-md border px-2 py-1.5 transition-colors",
            isCustomSelected || isCustomInputFocused
              ? "border-foreground/40 bg-muted/70"
              : "border-border hover:bg-muted/50",
          )}
        >
          <span className="text-[12px] text-muted-foreground">{i18n.t('Other:')}</span>
          <input
            type="text"
            value={currentCustomAnswer}
            onChange={(e) => handleCustomAnswerChange(e.target.value)}
            onFocus={() => setIsCustomInputFocused(true)}
            onBlur={() => setIsCustomInputFocused(false)}
            placeholder={i18n.t('Type your own answer')}
            disabled={isSubmitting}
            className="flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground/60"
          />
        </div>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-end gap-2 px-2 py-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={handleSkipWithGuard}
          disabled={isSubmitting}
          className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground"
        >
          Skip All
        </Button>
        <Button
          size="sm"
          onClick={handleContinue}
          disabled={
            isSubmitting ||
            hasCustomText ||
            (isLastQuestion ? !allQuestionsAnswered : !currentQuestionHasAnswer)
          }
          className="h-6 text-xs px-3 rounded-md"
        >
          {isSubmitting ? (
            "Sending..."
          ) : (
            <>
              {isLastQuestion ? "Submit" : "Continue"}
              <CornerDownLeft className="w-3 h-3 ml-1 opacity-60" />
            </>
          )}
        </Button>
      </div>
    </div>
  )
}))
