import { create } from "zustand";

import { chatTransport } from "@ergatai/platform-core";
import { useTaskStore, type TaskSource, type TaskStatus } from "./taskStore";

export type ConversationKind = "group" | "direct";
export type MessageSenderKind = "user" | "agent" | "system";
export type ActivityState = Extract<
  TaskStatus,
  "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled"
>;

export interface ActivityCard {
  runId: string;
  taskId: string;
  agentName: string;
  state: ActivityState;
  phase: string;
  summary: string;
  steps: string[];
  toolCalls: string[];
}

export interface ApprovalCard {
  approvalId: string;
  taskId: string;
  title: string;
  filePath: string;
  reason: string;
  state: "pending" | "approved" | "rejected";
}

export type ConversationMessagePart =
  | { type: "text"; content: string }
  | { type: "mention"; memberId: string; displayName: string }
  | { type: "task_ref"; taskId: string; title: string }
  | { type: "activity_card"; activity: ActivityCard }
  | { type: "approval"; approval: ApprovalCard }
  | { type: "artifact"; artifactId: string; kind: "diff" | "file" | "log" | "report"; label: string }
  | { type: "system_notice"; content: string };

export interface ConversationMember {
  id: string;
  name: string;
  kind: "user" | "agent";
  agentType?: string;
}

export interface Conversation {
  id: string;
  kind: ConversationKind;
  title: string;
  members: ConversationMember[];
}

export interface ConversationMessage {
  id: string;
  conversationId: string;
  senderKind: MessageSenderKind;
  senderId: string;
  senderName: string;
  parts: ConversationMessagePart[];
  createdAt: string;
}

interface ConversationState {
  conversations: Conversation[];
  messages: ConversationMessage[];
  sendMessage: (conversationId: string, content: string) => void;
  cancelAgentRun: (runId: string) => void;
  respondToApproval: (messageId: string, approvalId: string, approved: boolean) => void;
}

type ConversationSetter = (updater: (state: ConversationState) => Partial<ConversationState>) => void;

const activeAgentRuns = new Map<string, AbortController>();

function nowMinusMinutes(minutes: number) {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function createMessageId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `message-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

const conversations: Conversation[] = [
  {
    id: "group-1",
    kind: "group",
    title: "Auth 修复群",
    members: [
      { id: "user", name: "你", kind: "user" },
      { id: "agent1", name: "Codex", kind: "agent", agentType: "Codex" },
      { id: "agent2", name: "Claude", kind: "agent", agentType: "Claude" },
    ],
  },
  {
    id: "group-2",
    kind: "group",
    title: "前端重构",
    members: [
      { id: "user", name: "你", kind: "user" },
      { id: "agent1", name: "Codex", kind: "agent", agentType: "Codex" },
      { id: "agent2", name: "Claude", kind: "agent", agentType: "Claude" },
      { id: "agent3", name: "Gemini", kind: "agent", agentType: "Gemini" },
    ],
  },
  {
    id: "direct-1",
    kind: "direct",
    title: "Alice",
    members: [
      { id: "user", name: "你", kind: "user" },
      { id: "agent1", name: "Alice", kind: "agent", agentType: "Claude" },
    ],
  },
  {
    id: "direct-2",
    kind: "direct",
    title: "Bob",
    members: [
      { id: "user", name: "你", kind: "user" },
      { id: "agent2", name: "Bob", kind: "agent", agentType: "Codex" },
    ],
  },
];

const messages: ConversationMessage[] = [
  {
    id: "group-1-message-1",
    conversationId: "group-1",
    senderKind: "user",
    senderId: "user",
    senderName: "你",
    parts: [
      { type: "mention", memberId: "agent1", displayName: "Codex" },
      { type: "text", content: " 修复登录超时" },
      { type: "task_ref", taskId: "1", title: "修复登录超时" },
    ],
    createdAt: nowMinusMinutes(11),
  },
  {
    id: "group-1-message-2",
    conversationId: "group-1",
    senderKind: "agent",
    senderId: "agent1",
    senderName: "Codex",
    parts: [
      {
        type: "activity_card",
        activity: {
          runId: "run-1",
          taskId: "1",
          agentName: "Codex",
          state: "running",
          phase: "定位登录超时原因",
          summary: "已读取 auth/session.ts 和 auth/token.ts，正在验证 refresh token 竞态。",
          steps: [
            "开始分析登录链路",
            "读取 auth/session.ts",
            "读取 auth/token.ts",
            "定位到 refresh token 竞态",
          ],
          toolCalls: [
            "read_file(auth/session.ts)",
            "read_file(auth/token.ts)",
            "search_code(\"refresh token\")",
          ],
        },
      },
      { type: "artifact", artifactId: "auth-fix.patch", kind: "diff", label: "auth-fix.patch" },
    ],
    createdAt: nowMinusMinutes(8),
  },
  {
    id: "group-1-message-3",
    conversationId: "group-1",
    senderKind: "agent",
    senderId: "agent2",
    senderName: "Claude",
    parts: [
      {
        type: "approval",
        approval: {
          approvalId: "approval-1",
          taskId: "2",
          title: "应用审查结论",
          filePath: "src/auth/session.ts",
          reason: "Codex 建议合并修复，Claude 需要确认写入 3 个文件。",
          state: "pending",
        },
      },
    ],
    createdAt: nowMinusMinutes(3),
  },
  {
    id: "group-2-message-1",
    conversationId: "group-2",
    senderKind: "system",
    senderId: "system",
    senderName: "系统",
    parts: [{ type: "system_notice", content: "前端重构群已创建，邀请 Codex、Claude 和 Gemini 加入。" }],
    createdAt: nowMinusMinutes(120),
  },
  {
    id: "direct-1-message-1",
    conversationId: "direct-1",
    senderKind: "agent",
    senderId: "agent1",
    senderName: "Alice",
    parts: [{ type: "text", content: "我已准备好继续分析上次的问题。" }],
    createdAt: nowMinusMinutes(2),
  },
  {
    id: "direct-2-message-1",
    conversationId: "direct-2",
    senderKind: "agent",
    senderId: "agent2",
    senderName: "Bob",
    parts: [{ type: "text", content: "工作区已同步，可以发送任务。" }],
    createdAt: nowMinusMinutes(5),
  },
];

export const useConversationStore = create<ConversationState>((set) => ({
  conversations,
  messages,

  sendMessage: (conversationId, content) => {
    const conversation = conversations.find((item) => item.id === conversationId);
    if (!conversation || !content.trim()) return;

    const mentionedAgents = conversation.members.filter(
      (member) => member.kind === "agent" && content.toLowerCase().includes(`@${member.name.toLowerCase()}`),
    );
    const targetAgents = mentionedAgents.length
      ? mentionedAgents
      : conversation.kind === "group"
        ? conversation.members.filter((member) => member.kind === "agent")
        : conversation.members.filter((member) => member.kind === "agent").slice(0, 1);
    const messageId = createMessageId();
    const createdAt = new Date().toISOString();
    let textContent = content;
    const userParts: ConversationMessagePart[] = [];

    for (const agent of [...targetAgents].reverse()) {
      userParts.unshift({
        type: "mention",
        memberId: agent.id,
        displayName: agent.name,
      });
      textContent = textContent
        .replace(new RegExp(`@${agent.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "ig"), "")
        .replace(/\s+/g, " ")
        .trim();
    }

    if (textContent) {
      userParts.push({ type: "text", content: textContent });
    }

    set((state) => ({
      messages: [
        ...state.messages,
        {
          id: messageId,
          conversationId,
          senderKind: "user",
          senderId: "user",
          senderName: "你",
          parts: userParts,
          createdAt,
        },
      ],
    }));

    for (const agent of targetAgents) {
      const runId = createMessageId();
      const agentMessageId = createMessageId();
      const taskId = createMessageId();
      const title = textContent || `${agent.name} 任务`;
      const taskSource: TaskSource = conversation.kind === "group"
        ? { type: "group_chat", conversationId, messageId }
        : { type: "agent_mode", sessionId: conversationId, parentAgentId: agent.id };

      useTaskStore.getState().addTask({
        id: taskId,
        title,
        status: "queued",
        priority: "medium",
        source: taskSource,
        assignee: {
          id: agent.id,
          name: agent.name,
          type: agent.agentType ?? agent.name,
        },
        statusSummary: "已排队等待 Agent Run",
      });

      set((state) => ({
        messages: [
          ...state.messages,
          {
            id: agentMessageId,
            conversationId,
            senderKind: "agent",
            senderId: agent.id,
            senderName: agent.name,
            parts: [
              {
                type: "activity_card",
                activity: {
                  runId,
                  taskId,
                  agentName: agent.name,
                  state: "queued",
                  phase: "等待调度",
                  summary: "请求已接受，Agent Run 正在排队。",
                  steps: ["收到用户请求", "创建任务", "等待调度"],
                  toolCalls: [],
                },
              },
            ],
            createdAt: new Date().toISOString(),
          },
        ],
      }));

      void runAgentTurn({
        set,
        conversationId,
        agent,
        prompt: textContent,
        runId,
        agentMessageId,
        taskId,
        chatId: `${conversationId}:${agent.id}`,
      });
    }
  },

  cancelAgentRun: (runId) => {
    activeAgentRuns.get(runId)?.abort();
  },

  respondToApproval: (messageId, approvalId, approved) => {
    set((state) => ({
      messages: state.messages.map((message) =>
        message.id === messageId
          ? {
              ...message,
              parts: message.parts.map((part) =>
                part.type === "approval" && part.approval.approvalId === approvalId
                  ? {
                      ...part,
                      approval: {
                        ...part.approval,
                        state: approved ? "approved" : "rejected",
                      },
                    }
                  : part,
              ),
            }
          : message,
      ),
    }));

    const message = messages.find((item) => item.id === messageId);
    const approval = message?.parts.find(
      (part): part is Extract<ConversationMessagePart, { type: "approval" }> =>
        part.type === "approval" && part.approval.approvalId === approvalId,
    )?.approval;

    if (approval) {
      useTaskStore.getState().updateTask(approval.taskId, {
        status: approved ? "running" : "cancelled",
        statusSummary: approved ? "审批通过，开始执行" : "审批拒绝，任务已取消",
      });
    }
  },
}));

async function runAgentTurn({
  set,
  conversationId,
  agent,
  prompt,
  runId,
  agentMessageId,
  taskId,
  chatId,
}: {
  set: ConversationSetter;
  conversationId: string;
  agent: ConversationMember;
  prompt: string;
  runId: string;
  agentMessageId: string;
  taskId: string;
  chatId: string;
}) {
  const patchActivity = (patch: Partial<ActivityCard>) => {
    set((state) => ({
      messages: state.messages.map((message) => {
        if (message.id !== agentMessageId) return message;
        return {
          ...message,
          parts: message.parts.map((part) =>
            part.type === "activity_card" && part.activity.runId === runId
              ? { ...part, activity: { ...part.activity, ...patch } }
              : part,
          ),
        };
      }),
    }));
  };

  const appendText = (delta: string) => {
    set((state) => ({
      messages: state.messages.map((message) => {
        if (message.id !== agentMessageId) return message;
        const existingText = message.parts.find((part) => part.type === "text");
        if (existingText?.type !== "text") {
          return { ...message, parts: [...message.parts, { type: "text", content: delta }] };
        }
        return {
          ...message,
          parts: message.parts.map((part) =>
            part.type === "text" ? { ...part, content: part.content + delta } : part,
          ),
        };
      }),
    }));
  };

  const controller = new AbortController();
  activeAgentRuns.set(runId, controller);

  try {
    patchActivity({ state: "running", phase: "调用 Agent", summary: "已提交到 Agent Run。", steps: ["收到用户请求", "创建任务", "提交 Agent Run"] });
    useTaskStore.getState().updateTask(taskId, { status: "running", statusSummary: "Agent Run 执行中" });

    const stream = await chatTransport.sendMessages({
      trigger: "submit-message",
      chatId,
      messageId: undefined,
      messages: [{
        id: createMessageId(),
        role: "user",
        parts: [{ type: "text", text: prompt }],
      }],
      abortSignal: controller.signal,
      body: {
        conversationId,
        agentId: agent.id,
        agentName: agent.name,
        runId,
      },
    });

    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.type === "text-delta") appendText(value.delta);
      if (value.type === "error") throw new Error(value.errorText);
    }

    patchActivity({ state: "completed", phase: "完成", summary: "Agent 回复完成。" });
    useTaskStore.getState().updateTask(taskId, { status: "completed", statusSummary: "Agent Run 已完成" });
  } catch (error) {
    const cancelled = error instanceof DOMException && error.name === "AbortError";
    const summary = cancelled
      ? "用户停止了 Agent Run。"
      : error instanceof Error ? error.message : "Agent Run 执行失败。";

    patchActivity({
      state: cancelled ? "cancelled" : "failed",
      phase: cancelled ? "已停止" : "失败",
      summary,
    });
    useTaskStore.getState().updateTask(taskId, {
      status: cancelled ? "cancelled" : "failed",
      statusSummary: summary,
    });
  } finally {
    activeAgentRuns.delete(runId);
  }
}
