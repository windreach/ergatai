import type { CollaborationMode } from "../atoms"

type CollaborationChatLike = {
  id: string
  collaborationMode?: CollaborationMode | string | null
}

export function isChatInCollaborationMode<T extends CollaborationChatLike>(
  chat: T | undefined,
  mode: CollaborationMode,
): chat is T & { collaborationMode: CollaborationMode } {
  return chat?.collaborationMode === mode
}

export function filterChatsByCollaborationMode<
  T extends CollaborationChatLike,
>(chats: T[] | undefined, mode: CollaborationMode): T[] {
  return (chats ?? []).filter((chat) => isChatInCollaborationMode(chat, mode))
}

export function findChatOutsideCollaborationMode<
  T extends CollaborationChatLike,
>(
  chats: T[] | undefined,
  chatId: string | null,
  mode: CollaborationMode,
): T | undefined {
  if (!chatId) return undefined

  const chat = chats?.find((item) => item.id === chatId)
  return chat && !isChatInCollaborationMode(chat, mode) ? chat : undefined
}
