import { clearTextPartStoreByMessageIds } from "../main/text-part-store"
import { clearToolStateCachesByToolCallIds } from "../ui/agent-tool-utils"
import { clearConversationCaches } from "./message-store"

export function clearConversationRuntimeCaches(conversationId: string) {
  const { messageIds, toolCallIds } = clearConversationCaches(conversationId)
  clearTextPartStoreByMessageIds(conversationId, messageIds)
  clearToolStateCachesByToolCallIds(toolCallIds)
}
