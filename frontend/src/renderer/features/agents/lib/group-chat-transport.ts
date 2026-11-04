 

type UIMessageChunk = unknown

 
export class GroupChatTransport {
  async sendMessages(options: {
    messages: unknown[]
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
