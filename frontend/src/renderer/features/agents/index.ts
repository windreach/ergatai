// Public entry point for the agents feature.
// Keep this surface minimal: only exports that other features are allowed to depend on.

export * from "./stores/message-store"
export * from "./stores/streaming-status-store"

// Re-export buildGenericMentionToken from agents/mentions (used by mentions providers)
export { buildGenericMentionToken } from "./mentions/mentions-utils"
export type { AgentsMentionsEditorHandle } from "./mentions/agents-mentions-editor"

// Heavy/trpc-dependent modules moved to ./public

// Migration: expose atoms and shared UI/utilities needed by other features
export * from "./atoms"
export { getFileIconByExtension } from "./mentions/file-icon-utils"
export { CopyButton } from "./ui/message-action-buttons"
export { AgentDiffView } from "./ui/agent-diff-view"
export type { DiffViewMode } from "./ui/agent-diff-view"

// Layout/kanban cross-feature exports
export { useAgentsHotkeys } from "./lib/agents-hotkeys-manager"
export { toggleSearchAtom } from "./search"
export { AgentsContent } from "./ui/agents-content"
export * from "./stores/conversation-store"
export { QueueProcessor } from "./components/queue-processor"
export * from "./lib/drafts"
export * from "./lib/export-chat"
export { AgentsRenameConversationDialog } from "./components/agents-rename-conversation-dialog"
export { AgentsHeaderControls } from "./ui/agents-header-controls"

// Details-sidebar cross-feature exports
export { useMainChatInvocation } from "./hooks/use-main-chat-invocation"
export * from "./collaboration/group-chat-context"
export { ConversationStatusCard } from "./ui/conversation-status-card"
export { AgentHistorySelector } from "./ui/agent-history-selector"
export { useAgentsFileUpload, type UploadedImage, type UploadedFile } from "./hooks/use-agents-file-upload"
export { useChatAutoScroll } from "./hooks/use-chat-auto-scroll"
export { useTextContextSelection } from "./hooks/use-text-context-selection"
export type { UseTextContextSelectionReturn } from "./hooks/use-text-context-selection"
export { usePastedTextFiles } from "./hooks/use-pasted-text-files"
export type { PastedTextFile, UsePastedTextFilesReturn } from "./hooks/use-pasted-text-files"
export { useRollback } from "./hooks/use-rollback"
export { useForkConversation } from "./hooks/use-fork-conversation"
export { ChatInputArea } from "./main/chat-input-area"
export type { ChatInputAreaProps } from "./main/chat-input-area"
export { AgentContextIndicator } from "./ui/agent-context-indicator"
export type { MessageTokenData } from "./ui/agent-context-indicator"
export { ChatMessagesRenderer } from "./main/chat-messages-renderer"
export { ActiveChatMessages } from "./main/active-chat-messages"
export { ActiveChatDock } from "./main/active-chat-dock"
export { TextSelectionProvider } from "./context/text-selection-context"
export { TextSelectionPopover } from "./ui/text-selection-popover"
export { QuickCommentInput } from "./ui/quick-comment-input"
export { useQuickComment } from "./hooks/use-quick-comment"
export { useMessageQueueStore } from "./stores/message-queue-store"
export { useConversationChatSurface } from "./main/use-conversation-chat-surface"
export { ChatSurfaceShell } from "./main/chat-surface-shell"
export type { ChatSurfaceShellProps } from "./main/chat-surface-shell"
export { clearConversationRuntimeCaches } from "./stores/conversation-runtime-cleanup"
export { useChatInstance } from "./hooks/use-chat-instance"
// export { MonitoringPanel } from "./collaboration/monitoring-panel" (removed from UI)
export { useAgentParticipants } from "./collaboration/use-agent-participants"
export { AgentUserMessageBubble } from "./ui"

// Sidebar cross-feature exports
export { TrafficLightSpacer, TrafficLights } from "./components/traffic-light-spacer"
export { ConversationContextMenu } from "./ui/conversation-context-menu"
export { ConversationDropdownMenu } from "./ui/conversation-dropdown-menu"
export { getCoreAgentIcon } from "./components/core-agent-selector"
export * from "./collaboration/group-agent-storage"
export { useCollaborationMode } from "./collaboration/use-collaboration-mode"
export { ArchivePopover } from "./ui/archive-popover"
export { AgentsHelpPopover } from "./components/agents-help-popover"
export { getPathDeduplicatedNames } from "./lib/workspace-naming"
export * from "./collaboration/collaboration-mode"
export * from "./collaboration/collaboration-mode-utils"
export * from "./stores/workspace-chats-store"
