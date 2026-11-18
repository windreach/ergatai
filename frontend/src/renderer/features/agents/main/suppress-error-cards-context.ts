import { createContext } from "react"

/**
 * When true, message error parts inside the wrapped tree are not rendered as
 * error cards. Used while an automatic retry is in progress: the retry row is
 * the only failure indicator, so each internal attempt does not flash another
 * red error into the conversation.
 */
export const SuppressErrorCardsContext = createContext(false)
