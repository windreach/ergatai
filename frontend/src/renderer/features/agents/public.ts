// Heavy/trpc-dependent exports for cross-feature use.
// Import from "@/features/agents/public" instead of "@/features/agents" to avoid
// pulling these modules into lightweight feature entry points.
export * from "./lib/agent-contract-api"
export { isErgataiSendMessagePart } from "./lib/ergatai-mcp-detection"
export * from "./lib/ergatai-chat-transport"
export * from "./lib/group-chat-transport"
export * from "./lib/agent-runtime-status-store"
export type { AgentMessageMetadata } from "./ui/agent-message-usage"

// Shared chat surface hooks consumed by main and side chats.
export { useChangedFilesTracking } from "./hooks/use-changed-files-tracking"
export { useMessageTokenData } from "./hooks/use-message-token-data"
export { useActiveChatConversationMeta } from "./main/use-active-chat-conversation-meta"
