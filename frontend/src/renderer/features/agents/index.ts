// Public entry point for the agents feature.
// Keep this surface minimal: only exports that other features are allowed to depend on.

export { syncMessagesWithStatusAtom } from "./stores/message-store"
export type { Message } from "./stores/message-store"
