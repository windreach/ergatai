import type { ChatTransport, UIMessage, UIMessageChunk } from "ai"

import type { CoreAgentOption } from "./agent-contract-api"
import type { GroupAgentRuntimeStatuses } from "../collaboration/group-agent-runtime"
import type { GroupAgentRuntimeStatus } from "../collaboration/group-agent-runtime"
import { setGroupAgentRuntimeStatuses } from "../collaboration/group-agent-runtime"
import { loadGroupAgents } from "../collaboration/group-agent-storage"
import { createLocalId } from "../../../../shared/id"

type MockChatTransportConfig = {
  chatId: string
  conversationId: string
  mode: "plan" | "agent"
  groupAgents?: CoreAgentOption[]
}

export type MockGroupAgentTaskStatus = GroupAgentRuntimeStatus

export type MockGroupAgentTask = {
  agent: CoreAgentOption
  status: MockGroupAgentTaskStatus
}

const MOCK_CHAT_STORAGE_KEY = "mock-chat-enabled"

export function isMockChatEnabled(): boolean {
  return import.meta.env.DEV && localStorage.getItem(MOCK_CHAT_STORAGE_KEY) === "true"
}

export function setMockChatEnabled(enabled: boolean): void {
  if (enabled) {
    localStorage.setItem(MOCK_CHAT_STORAGE_KEY, "true")
  } else {
    localStorage.removeItem(MOCK_CHAT_STORAGE_KEY)
  }
}

export function getMockGroupAgentConversation(
  agent: CoreAgentOption,
  prompt: string,
) {
  const topic = prompt || "当前任务"

  return {
    thinking: `${agent.name} 正在拆解「${topic}」。先确认目标，再检查上下文和风险，最后组织可执行回复。`,
    response: `${agent.name} 的回复：围绕「${topic}」，我会先给出结论，再补充关键步骤和注意事项。`,
  }
}

export function getMockGroupAgentTasks(
  agents: CoreAgentOption[],
  prompt: string,
  statuses: GroupAgentRuntimeStatuses = {},
): MockGroupAgentTask[] {
  void prompt

  return agents.map((agent, index) => ({
    agent,
    status: statuses[agent.id] ?? "pending",
  }))
}

function extractLastUserPrompt(messages: UIMessage[]): string {
  const lastUserMessage = [...messages].reverse().find((message) => message.role === "user")
  const text = lastUserMessage?.parts
    ?.filter((part): part is Extract<typeof part, { type: "text"; text?: string }> =>
      part.type === "text" && typeof (part as { text?: unknown }).text === "string" &&
      ((part as { text?: string }).text?.trim() ?? "").length > 0,
    )
    .map((part) => (part.text as string).trim())
    .join("\n") ?? ""

  return text.slice(0, 80)
}

function extractMentionedGroupAgents(
  messages: UIMessage[],
  groupAgents: CoreAgentOption[],
): CoreAgentOption[] {
  const lastUserMessage = [...messages]
    .reverse()
    .find((message) => message.role === "user")
  const text = lastUserMessage?.parts
    ?.filter((part): part is Extract<typeof part, { type: "text"; text?: string }> =>
      part.type === "text" && typeof (part as { text?: unknown }).text === "string",
    )
    .map((part) => part.text as string)
    .join("\n") ?? ""

  const mentionedNames = new Set<string>()
  const mentionPattern = /@\[agent:([^\]]+)\]/g
  let match: RegExpExecArray | null

  while ((match = mentionPattern.exec(text)) !== null) {
    mentionedNames.add(match[1].trim().toLowerCase())
  }

  if (mentionedNames.size === 0) {
    const plainPattern = /@([^\s，。,.]+)/g
    while ((match = plainPattern.exec(text)) !== null) {
      mentionedNames.add(match[1].trim().toLowerCase())
    }
  }

  return groupAgents.filter((agent) => mentionedNames.has(agent.name.toLowerCase()))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function enqueueToolCall(
  controller: ReadableStreamDefaultController<UIMessageChunk>,
  toolCallId: string,
  toolName: string,
  input: unknown,
  output: unknown,
) {
  controller.enqueue({ type: "tool-input-start", toolCallId, toolName })
  controller.enqueue({ type: "tool-input-available", toolCallId, toolName, input })
  controller.enqueue({ type: "tool-output-available", toolCallId, output })
}

export class MockChatTransport implements ChatTransport<UIMessage> {
  constructor(private config: MockChatTransportConfig) {}

  async sendMessages(options: {
    messages: UIMessage[]
  }): Promise<ReadableStream<UIMessageChunk>> {
    const prompt = extractLastUserPrompt(options.messages)
    const chatId = this.config.chatId
    const boundGroupAgents = this.config.groupAgents
      ? loadGroupAgents(chatId)
      : []
    const taskAgents = extractMentionedGroupAgents(
      options.messages,
      boundGroupAgents,
    )
    const responseAgent = taskAgents[0] ?? boundGroupAgents[0]
    const conversation = responseAgent
      ? getMockGroupAgentConversation(responseAgent, prompt)
      : null
    const acknowledgmentText = responseAgent
      ? `${responseAgent.name}: 收到，任务正在执行。详细情况点击下方 ${responseAgent.name} 查看完整信息。`
      : `收到：${prompt || "空消息"}。这是统一 mock 通道返回的回复，用于验证真实消息链路。`
    const finalText = conversation?.response ?? acknowledgmentText
    if (chatId && taskAgents.length > 0) {
      setGroupAgentRuntimeStatuses(chatId, {
        ...Object.fromEntries(
          taskAgents.map((agent) => [agent.id, "running" as const]),
        ),
      })
    }

    return new ReadableStream<UIMessageChunk>({
      async start(controller) {
        const messageId = createLocalId("mock-message")
        const thinkingId = createLocalId("mock-thinking")
        const webSearchId = createLocalId("mock-search")

        controller.enqueue({
          type: "start",
          messageId,
          messageMetadata: responseAgent
            ? {
                agentId: responseAgent.id,
                agentName: responseAgent.name,
              }
            : undefined,
        })
        controller.enqueue({ type: "start-step" })

        const acknowledgmentId = createLocalId("mock-text")
        controller.enqueue({ type: "text-start", id: acknowledgmentId })
        controller.enqueue({
          type: "text-delta",
          id: acknowledgmentId,
          delta: acknowledgmentText,
        })
        controller.enqueue({ type: "text-end", id: acknowledgmentId })
        controller.enqueue({ type: "finish-step" })

        await sleep(1600)

        controller.enqueue({ type: "start-step" })

        enqueueToolCall(
          controller,
          thinkingId,
          "Thinking",
          { text: "用户想验证思考记录的展示样式。先确认用户意图，再整理回复结构。" },
          { completed: true },
        )

        enqueueToolCall(
          controller,
          webSearchId,
          "WebSearch",
          { query: "mock chat reply streaming" },
          {
            results: [
              { title: "Mock search result", url: "https://example.com/mock-search" },
            ],
          },
        )

        controller.enqueue({ type: "text-start", id: messageId })

        for (const word of finalText.split("")) {
          await sleep(12)
          controller.enqueue({
            type: "text-delta",
            id: messageId,
            delta: word,
          })
        }

        controller.enqueue({ type: "text-end", id: messageId })
        controller.enqueue({ type: "finish-step" })
        try {
          controller.enqueue({ type: "finish", finishReason: "stop" })
          controller.close()
        } catch (err) {
          controller.error(err)
          throw err
        } finally {
          if (chatId) {
            setGroupAgentRuntimeStatuses(chatId, {
              ...Object.fromEntries(
                taskAgents.map((agent) => [agent.id, "completed" as const]),
              ),
            })
          }
        }
      },
    })
  }

  async reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    return null
  }
}
