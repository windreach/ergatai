import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

type FetchCall = {
  path: string
  init?: RequestInit
}

const fetchCalls: FetchCall[] = []
let responses: Array<{ matches: (call: FetchCall) => boolean; result: unknown }> = []

mock.module("../src/main/lib/ergatai/api", () => ({
  isErgataiApiError: () => false,
  ergataiFetch: async <T,>(path: string, init?: RequestInit): Promise<T> => {
    const call = { path, init }
    fetchCalls.push(call)
    const response = responses.find((candidate) => candidate.matches(call))
    if (!response) throw new Error(`Unexpected request: ${path}`)
    return response.result as T
  },
}))

const {
  appendConversationMessage,
  createChildConversation,
  getConversation,
  listChildConversations,
  listWorkspaceConversations,
  replaceConversationMessages,
  updateConversation,
  unarchiveConversation,
  updateSubChatMessages,
} = await import("../src/main/lib/ergatai/user-data")

const conversation = {
  id: "conversation-root",
  parent_id: null,
  project_id: "project-1",
  workspace_id: "workspace-1",
  name: "Root conversation",
  mode: "agent",
  created_at: 1,
  updated_at: 2,
  archived_at: null,
}

describe("conversation adapters", () => {
  beforeEach(() => {
    fetchCalls.length = 0
    responses = []
  })

  afterEach(() => {
    mock.restore()
  })

  test("lists workspace conversations through the canonical path", async () => {
    responses.push({
      matches: (call) => call.path === "/api/v1/workspaces/workspace-1/conversations",
      result: [conversation],
    })

    await expect(listWorkspaceConversations("workspace-1")).resolves.toEqual([
      conversation,
    ])
  })

  test("creates child conversations with the parent path and name payload", async () => {
    const child = { ...conversation, id: "conversation-child", parent_id: conversation.id }
    responses.push({
      matches: (call) => (
        call.init?.method === "POST" &&
        call.path === "/api/v1/conversations/conversation-root/children"
      ),
      result: child,
    })

    await expect(
      createChildConversation("conversation-root", { name: "Child", mode: "agent" }),
    ).resolves.toEqual(child)
    expect(JSON.parse(fetchCalls[0].init?.body as string)).toEqual({
      name: "Child",
      mode: "agent",
    })
  })

  test("navigates conversations by id and parent", async () => {
    const child = { ...conversation, id: "conversation-child", parent_id: conversation.id }
    responses.push(
      {
        matches: (call) => (
          call.path === "/api/v1/conversations/conversation-root" &&
          !call.init?.method
        ),
        result: conversation,
      },
      {
        matches: (call) => call.path === "/api/v1/conversations/conversation-root/children",
        result: [child],
      },
    )

    await expect(getConversation("conversation-root")).resolves.toEqual(conversation)
    await expect(listChildConversations("conversation-root")).resolves.toEqual([child])
  })

  test("updates and unarchives conversations through the canonical paths", async () => {
    const renamed = { ...conversation, name: "Renamed" }
    const restored = { ...renamed, archived_at: null }
    responses.push(
      {
        matches: (call) => (
          call.init?.method === "PATCH" &&
          call.path === "/api/v1/conversations/conversation-root"
        ),
        result: renamed,
      },
      {
        matches: (call) => (
          call.init?.method === "POST" &&
          call.path === "/api/v1/conversations/conversation-root/unarchive"
        ),
        result: restored,
      },
    )

    await expect(
      updateConversation("conversation-root", { name: "Renamed" }),
    ).resolves.toEqual(renamed)
    expect(JSON.parse(fetchCalls[0].init?.body as string)).toEqual({ name: "Renamed" })

    await expect(unarchiveConversation("conversation-root")).resolves.toEqual(restored)
  })

  test("appends normalized messages to a conversation", async () => {
    const message = { id: "message-1", parts: "[]" }
    responses.push({
      matches: (call) => (
        call.init?.method === "POST" &&
        call.path === "/api/v1/conversations/conversation-root/messages"
      ),
      result: message,
    })

    await expect(appendConversationMessage("conversation-root", {
      role: "user",
      text: "Hello",
      metadata: { conversationId: "conversation-root" },
    })).resolves.toEqual(message)
    expect(JSON.parse(fetchCalls[0].init?.body as string)).toMatchObject({
      role: "user",
      text: "Hello",
      metadata: { conversationId: "conversation-root" },
    })
  })

  test("replaces normalized messages through a bulk PUT", async () => {
    responses.push({
      matches: (call) => (
        call.init?.method === "PUT" &&
        call.path === "/api/v1/conversations/conversation-root/messages"
      ),
      result: [{ id: "message-1", parts: "[]" }],
    })

    await expect(replaceConversationMessages("conversation-root", [
      { role: "user", text: "Hello" },
    ])).resolves.toHaveLength(1)
    expect(JSON.parse(fetchCalls[0].init?.body as string)).toEqual({
      messages: [{ role: "user", text: "Hello" }],
    })
  })

  test("validates and replaces legacy sub-chat message payloads", async () => {
    responses.push(
      {
        matches: (call) => call.init?.method === "PUT" && call.path.includes("/messages"),
        result: [{ id: "message-1", parts: "[]" }],
      },
      {
        matches: (call) => call.path === "/api/v1/conversations/conversation-child",
        result: { id: "conversation-child", messages: "[]" },
      },
    )

    await expect(updateSubChatMessages("conversation-child", "[]")).resolves.toMatchObject({
      id: "conversation-child",
    })
    expect(fetchCalls.map((call) => call.init?.method)).toEqual(["PUT", undefined])

    await expect(updateSubChatMessages("conversation-child", "{")).rejects.toThrow(
      "Invalid messages payload",
    )
  })
})
