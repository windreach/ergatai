/**
 * Context for fork callback.
 * Separated from isolated-message-group.tsx to maintain Fast Refresh compatibility.
 */
import { createContext } from "react"

export const ForkContext = createContext<((messageId: string) => void) | null>(null)
