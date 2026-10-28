import type { ChatTransport, UIMessage } from "ai"

type UIMessageChunk = any

export class GroupChatTransport implements ChatTransport<UIMessage> {
  async sendMessages(options: {
    messages: UIMessage[]
    abortSignal?: AbortSignal
  }): Promise<ReadableStream<UIMessageChunk>> {
    // TODO: Implement actual group chat transport logic
    void options
    return new ReadableStream<UIMessageChunk>({
      start(controller) {
        controller.enqueue({ type: "finish" })
        controller.close()
      },
    })
  }

  async reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    return null
  }
}
