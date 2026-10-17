export interface ChatAgentOption {
  id: string
  name: string
}

export interface ChatMessageImage {
  id: string
  filename: string
  url: string
  base64Data?: string
  mediaType?: string
}

export interface ChatMessage {
  id: string
  role: "user" | "assistant" | "agent"
  content: string
  reasoning?: string
  images?: ChatMessageImage[]
  senderAgentId?: string
  senderAgentName?: string
  metadata?: Record<string, unknown>
  parts?: unknown[]
}

export interface ChatConversation {
  id: string
  backendConversationId?: string
  agent: ChatAgentOption
  messages: ChatMessage[]
}

export interface ChatContractApi {
  createConversation(
    agent: ChatAgentOption,
    backendConversationId?: string,
  ): Promise<ChatConversation>
}

function delay<T>(value: T, milliseconds = 80): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), milliseconds))
}

export const chatContractApi: ChatContractApi = {
  createConversation(agent, backendConversationId) {
    const conversation: ChatConversation = {
      id: backendConversationId ?? `chat-${crypto.randomUUID()}`,
      backendConversationId,
      agent: { ...agent },
      messages: [],
    }

    return delay(conversation)
  },
}
