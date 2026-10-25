import { clearMessageStateCacheByMessageIds } from "../main/assistant-message-item"
import { clearTextPartStoreByMessageIds } from "../main/text-part-store"
import { clearToolStateCachesByToolCallIds } from "../ui/agent-tool-utils"
import { clearConversationCaches } from "./message-store"

export function clearConversationRuntimeCaches(conversationId: string) {
  const { messageIds, toolCallIds } = clearConversationCaches(conversationId)
  clearMessageStateCacheByMessageIds(conversationId, messageIds)
  clearTextPartStoreByMessageIds(conversationId, messageIds)
  clearToolStateCachesByToolCallIds(toolCallIds)
}
