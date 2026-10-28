import { useStreamingStatusStore } from "../stores/streaming-status-store"

const STREAMING_READY_TIMEOUT_MS = 30_000

export function waitForStreamingReady(conversationId: string): Promise<void> {
  return new Promise((resolve) => {
    if (!useStreamingStatusStore.getState().isStreaming(conversationId)) {
      resolve()
      return
    }

    let unsub: () => void
    const timeout = setTimeout(() => {
      console.warn(
        `[waitForStreamingReady] Timed out after ${STREAMING_READY_TIMEOUT_MS}ms for conversation ${conversationId.slice(-8)}, proceeding anyway`
      )
      unsub()
      resolve()
    }, STREAMING_READY_TIMEOUT_MS)

    unsub = useStreamingStatusStore.subscribe(
      (state) => state.statuses[conversationId],
      (status) => {
        if (status === "ready" || status === undefined) {
          clearTimeout(timeout)
          unsub()
          resolve()
        }
      }
    )
  })
}
