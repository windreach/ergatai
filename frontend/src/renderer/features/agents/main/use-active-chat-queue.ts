import { useCallback, useMemo, useRef, useState } from "react"
import type { MessagePart } from "../stores/message-store"
import type { AgentQueueItem } from "../lib/queue-utils"

export function useActiveChatQueue({
  invocationQueue,
  chatInvocation,
}: {
  invocationQueue: any[]
  chatInvocation: { service?: { enqueue: (item: any) => void }; removeQueuedItem: (conversationId: string, itemId: string) => any }}) {
  const queueCacheRef = useRef<{
    items: typeof invocationQueue
    result: Array<{
      id: string
      message: string
      images: Array<{
        id: string
        url: string
        mediaType: string
        filename: string
        base64Data?: string
        isLoading: boolean
        preview: string
      }>
      files: Array<{
        id: string
        url: string
        mediaType: string
        filename: string
        size: number
        isLoading: boolean
        preview: string
      }>
      timestamp: Date
      status: "pending" | "processing" | "completed" | "failed"
    }>
  } | null>(null)

  const queue = useMemo(() => {
    if (
      queueCacheRef.current &&
      queueCacheRef.current.items === invocationQueue &&
      queueCacheRef.current.items.length === invocationQueue.length
    ) {
      return queueCacheRef.current.result
    }

    const result = invocationQueue.map((item) => {
      const parts = item.originalInput.parts || []

      const textPart = parts.find((p: MessagePart) => p.type === "text")
      const imageParts = parts.filter((p: MessagePart) => p.type === "data-image")
      const fileParts = parts.filter((p: MessagePart) => p.type === "data-file")

      return {
        id: item.id,
        message: textPart?.text || "",
        images: imageParts.map((p: MessagePart, idx: number) => ({
          id: `img_${item.id}_${idx}`,
          url: (p.data as { url?: string })?.url || "",
          mediaType: (p.data as { mediaType?: string })?.mediaType || "image/png",
          filename: (p.data as { filename?: string })?.filename || "image.png",
          base64Data: (p.data as { base64Data?: string })?.base64Data,
          isLoading: false,
          preview: (p.data as { url?: string })?.url || "",
        })),
        files: fileParts.map((p: MessagePart, idx: number) => ({
          id: `file_${item.id}_${idx}`,
          url: (p.data as { url?: string })?.url || "",
          mediaType: (p.data as { mediaType?: string })?.mediaType || "application/octet-stream",
          filename: (p.data as { filename?: string })?.filename || "file",
          size: (p.data as { size?: number })?.size || 0,
          isLoading: false,
          preview: (p.data as { filename?: string })?.filename || "file",
        })),
        timestamp: item.queuedAt,
        status: item.status,
      }
    })

    queueCacheRef.current = { items: invocationQueue, result }

    return result
  }, [invocationQueue])

  const addToQueue = useCallback((conversationId: string, item: AgentQueueItem) => {
    chatInvocation.service?.enqueue(item)
  }, [chatInvocation.service])

  const removeFromQueue = chatInvocation.removeQueuedItem

  const popItemFromQueue = chatInvocation.removeQueuedItem

  const [planApprovalPending, setPlanApprovalPending] = useState<
    Record<string, boolean>
  >({})

  return {
    queueCacheRef,
    queue,
    addToQueue,
    removeFromQueue,
    popItemFromQueue,
    planApprovalPending,
    setPlanApprovalPending,
  }
}
