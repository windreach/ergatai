import { useEffect } from "react"

type KeyboardQuestion = {
  options?: Array<{ label: string }>
}

interface UseAgentQuestionKeyboardOptions {
  containerRef: React.RefObject<HTMLDivElement | null>
  isSubmitting: boolean
  focusedOptionIndex: number
  currentOptions: Array<{ label: string }>
  questions: KeyboardQuestion[]
  currentQuestionIndex: number
  currentQuestionHasAnswer: boolean
  setFocusedOptionIndex: (index: number) => void
  setCurrentQuestionIndex: (index: number) => void
  handleOptionClick: (optionLabel: string, questionIndex: number) => void
  handleContinue: () => void
}

/**
 * Keyboard navigation for the shared question dock. Kept in a separate hook so
 * the component stays focused on rendering and answer state.
 */
export function useAgentQuestionKeyboard({
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
}: UseAgentQuestionKeyboardOptions) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isSubmitting) return

      // Only intercept events within this component's DOM tree
      if (!containerRef.current?.contains(e.target as Node)) {
        return
      }

      const activeEl = document.activeElement
      if (
        activeEl instanceof HTMLInputElement ||
        activeEl instanceof HTMLTextAreaElement ||
        activeEl?.getAttribute("contenteditable") === "true"
      ) {
        return
      }

      if (e.key === "ArrowDown") {
        e.preventDefault()
        if (focusedOptionIndex < currentOptions.length - 1) {
          setFocusedOptionIndex(focusedOptionIndex + 1)
        } else if (currentQuestionIndex < questions.length - 1) {
          setCurrentQuestionIndex(currentQuestionIndex + 1)
          setFocusedOptionIndex(0)
        }
      } else if (e.key === "ArrowUp") {
        e.preventDefault()
        if (focusedOptionIndex > 0) {
          setFocusedOptionIndex(focusedOptionIndex - 1)
        } else if (currentQuestionIndex > 0) {
          const prevQuestionOptions =
            questions[currentQuestionIndex - 1]?.options || []
          setCurrentQuestionIndex(currentQuestionIndex - 1)
          setFocusedOptionIndex(prevQuestionOptions.length - 1)
        }
      } else if (e.key === "Enter") {
        e.preventDefault()
        if (currentQuestionHasAnswer) {
          handleContinue()
        } else if (currentOptions[focusedOptionIndex]) {
          handleOptionClick(
            currentOptions[focusedOptionIndex].label,
            currentQuestionIndex,
          )
        }
      } else if (e.key >= "1" && e.key <= "9") {
        const numberIndex = parseInt(e.key, 10) - 1
        if (numberIndex >= 0 && numberIndex < currentOptions.length) {
          e.preventDefault()
          handleOptionClick(
            currentOptions[numberIndex].label,
            currentQuestionIndex,
          )
          setFocusedOptionIndex(numberIndex)
        }
      }
    }

    document.addEventListener("keydown", handleKeyDown)
    return () => document.removeEventListener("keydown", handleKeyDown)
  }, [
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
  ])
}
