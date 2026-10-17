import { BrowserWindow } from "electron"
import * as fs from "fs/promises"
import * as path from "path"
import simpleGit from "simple-git"
import { z } from "zod"
import { getOllamaUrl } from "../../config"
import {
  trackPRCreated,
  trackWorkspaceArchived,
  trackWorkspaceCreated,
  trackWorkspaceDeleted,
} from "../../analytics"
import {
  createWorktreeForChat,
  fetchGitHubPRStatus,
  getWorktreeDiff,
  removeWorktree,
  sanitizeProjectName,
} from "../../git"
import type { WorktreeSetupResult } from "../../git/worktree-config"
import { computeContentHash, gitCache } from "../../git/cache"
import { splitUnifiedDiffByFile } from "../../git/diff-parser"
import { execWithShellEnv } from "../../git/shell-env"
import { applyRollbackStash } from "../../git/stash"
import { checkOllamaStatus } from "../../ollama"
import { terminalManager } from "../../terminal/manager"
import { publicProcedure, router } from "../index"
import {
  archiveConversation,
  deleteConversation,
  getConversation,
  listConversationMessages,
  listWorkspaceConversations,
  updateConversation,
  listConversationMessages as listMessages,
  type BackendMessage,
  type BackendConversation,
} from "../../ergatai/user-data"
import { ergataiCaller as trpcClient } from "../../ergatai/caller"
import { projectIdSchema } from "../../validation/ids"

type WorktreeSetupFailurePayload = {
  kind: "create-failed" | "setup-failed"
  message: string
  projectId: string
}

type MappedConversation = {
  id: string
  name: string | null
  chatId: string
  sessionId: string | null
  mode: string
  messages: string
  createdAt: Date
  updatedAt: Date
}

type ChatRecord = Awaited<ReturnType<typeof trpcClient.listChats>>[number]

async function resolveChatWorkspace(
  projectId: string,
  workDir: string,
  workspaceId: string | undefined,
  collaborationMode: "supervisor" | "group",
): Promise<string> {
  if (workspaceId) return workspaceId

  const workspaces = await trpcClient.listPersistentWorkspaces({
    projectId,
    collaborationMode,
  })
  const existingWorkspace = workspaces.find(
    (workspace) => workspace.collaborationMode === collaborationMode,
  )
  if (existingWorkspace) return existingWorkspace.id

  const createdWorkspace = await trpcClient.createPersistentWorkspace({
    projectId,
    workDir,
    collaborationMode,
  })
  return createdWorkspace.id
}

function mapBackendConversation(conversation: BackendConversation): MappedConversation {
  return {
    id: conversation.id,
    name: conversation.name,
    chatId: conversation.id,
    sessionId: null, // Conversations don't have session_id in the new model
    mode: conversation.mode,
    messages: "[]", // Messages are now in a separate table
    createdAt: new Date(conversation.created_at * 1000),
    updatedAt: new Date(conversation.updated_at * 1000),
  }
}

function findLegacyChatOwner(
  chatCandidates: ChatRecord[],
  conversation: BackendConversation,
): ChatRecord | null {
  let ownerChat: ChatRecord | null = null
  for (const candidateChat of chatCandidates) {
    if (candidateChat.createdAt.getTime() <= conversation.created_at * 1000) {
      ownerChat = candidateChat
    } else {
      break
    }
  }
  return ownerChat
}

async function listWorkspaceChatCandidates(workspaceId: string): Promise<ChatRecord[]> {
  return (await trpcClient.listChats({ workspaceId }))
    .filter((chat) => chat.id.startsWith("chat_"))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
}

async function findChatForConversation(
  conversation: BackendConversation,
): Promise<ChatRecord | null> {
  if (!conversation.workspace_id) return null

  const chatCandidates = await listWorkspaceChatCandidates(conversation.workspace_id)
  if (conversation.id.startsWith("chat_")) {
    return chatCandidates.find((chat) => chat.id === conversation.id) ?? null
  }

  return findLegacyChatOwner(chatCandidates, conversation)
}

async function listConversationsForChat(chat: {
  id: string
  workspaceId: string | null
  createdAt: Date
}): Promise<BackendConversation[]> {
  // Backend no longer supports listing child conversations
  // Return empty array as child conversations are no longer available
  const childConversations: BackendConversation[] = []
  if (!chat.workspaceId) return childConversations

  const [workspaceConversations, workspaceChats] = await Promise.all([
    listWorkspaceConversations(chat.workspaceId),
    listWorkspaceChatCandidates(chat.workspaceId),
  ])

  const legacyConversations = workspaceConversations.filter((conversation) => {
    if (!conversation.id.startsWith("conversation_") || conversation.archived_at !== null) {
      return false
    }

    const ownerChat = findLegacyChatOwner(workspaceChats, conversation)
    return ownerChat?.id === chat.id
  })

  return [...childConversations, ...legacyConversations]
}

function sendWorktreeSetupFailure(
  windowId: number | null,
  payload: WorktreeSetupFailurePayload,
): void {
  const targets: BrowserWindow[] = []

  if (windowId !== null) {
    const window = BrowserWindow.fromId(windowId)
    if (window && !window.isDestroyed()) {
      targets.push(window)
    }
  }

  if (targets.length === 0) {
    targets.push(...BrowserWindow.getAllWindows())
  }

  for (const window of targets) {
    if (window.isDestroyed()) continue
    window.webContents.send("worktree:setup-failed", payload)
  }
}

/**
 * Generate commit message using local Ollama model
 * Used for commit message generation in offline mode
 * @param diff - The diff text
 * @param fileCount - Number of files changed
 * @param additions - Lines added
 * @param deletions - Lines deleted
 * @param model - Optional model to use (if not provided, uses recommended model)
 */
async function generateCommitMessageWithOllama(
  diff: string,
  fileCount: number,
  additions: number,
  deletions: number,
  model?: string | null
): Promise<string | null> {
  try {
    const ollamaStatus = await checkOllamaStatus()
    if (!ollamaStatus.available) {
      return null
    }

    // Use provided model, or recommended, or first available
    const modelToUse = model || ollamaStatus.recommendedModel || ollamaStatus.models[0]
    if (!modelToUse) {
      console.error("[Ollama] No model available")
      return null
    }

    const prompt = `Generate a conventional commit message for these changes. Use format: type: short description

Types: feat (new feature), fix (bug fix), docs, style, refactor, test, chore

Changes: ${fileCount} files, +${additions}/-${deletions} lines

Diff (truncated):
${diff.slice(0, 3000)}

Commit message:`

    const ollamaUrl = getOllamaUrl()
    const response = await fetch(`${ollamaUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: modelToUse,
        prompt,
        stream: false,
        options: {
          temperature: 0.3,
          num_predict: 50,
        },
      }),
    })

    if (!response.ok) {
      console.error("[Ollama] Generate commit message failed:", response.status)
      return null
    }

    const data = await response.json()
    const result = data.response?.trim()
    if (result) {
      // Clean up - get just the first line
      const firstLine = result.split("\n")[0]?.trim()
      if (firstLine && firstLine.length > 0 && firstLine.length < 100) {
        return firstLine
      }
    }
    return null
  } catch (error) {
    console.error("[Ollama] Generate commit message error:", error)
    return null
  }
}

export const chatsRouter = router({
  /**
   * List all non-archived chats (optionally filter by project or workspace)
   */
  list: publicProcedure
    .input(z.object({
      workspaceId: z.string().optional(),
    }))
    .query(async ({ input }) => {
      const allChats = await trpcClient.listChats({
        workspaceId: input.workspaceId,
      })
      return allChats.filter((chat) => chat.id.startsWith("chat_") && !chat.archivedAt)
    }),

  /**
   * List archived chats (optionally filtered by workspace)
   */
  listArchived: publicProcedure
    .input(z.object({
      workspaceId: z.string().optional(),
    }))
    .query(async ({ input }) => {
      const allChats = await trpcClient.listChats({
        workspaceId: input.workspaceId,
      })
      return allChats.filter((chat) => chat.id.startsWith("chat_") && chat.archivedAt)
    }),

  /**
   * Get a single chat with all conversations
   */
  get: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      const chat = await trpcClient.getChat({ id: input.id })
      if (!chat) return null

      const chatConversations = await listConversationsForChat(chat)
      // Backend no longer provides project endpoint
      // Use mock project for backward compatibility
      const project = {
        id: chat.projectId,
        path: "/mock/path",
        name: "Mock Project",
      }

      // Fetch messages for each conversation
      const conversationsWithMessages = await Promise.all(
        chatConversations.map(async (conversation) => {
          const messages = await listConversationMessages(conversation.id)
          console.log(`[chats.get] Conversation ${conversation.id} name="${conversation.name}" has ${messages.length} messages`)
          // Map BackendConversation (snake_case) to Conversation (camelCase) format
          return {
            id: conversation.id,
            parentId: null,
            projectId: "",
            workspaceId: conversation.workspace_id,
            name: conversation.name,  // Keep as 'name' for frontend compatibility
            title: conversation.name, // Also provide 'title' for backward compatibility
            mode: conversation.mode,
            createdAt: new Date(conversation.created_at * 1000),
            updatedAt: new Date(conversation.updated_at * 1000),
            archivedAt: conversation.archived_at === null
              ? null
              : new Date(conversation.archived_at * 1000),
            created_at: conversation.created_at,
            updated_at: conversation.updated_at,
            messages: JSON.stringify(messages),
          }
        })
      )

      console.log(`[chats.get] Chat ${input.id} has ${conversationsWithMessages.length} conversations`)
      return { ...chat, conversations: conversationsWithMessages, project }
    }),

  /**
   * Create a new chat with optional git worktree
   */
  create: publicProcedure
    .input(
      z.object({
        projectId: projectIdSchema,
        workspaceId: z.string().optional(),
        name: z.string().optional(),
        model: z.string().optional(),
        initialMessage: z.string().optional(),
        initialMessageParts: z
          .array(
            z.union([
              z.object({ type: z.literal("text"), text: z.string() }),
              z.object({
                type: z.literal("data-image"),
                data: z.object({
                  url: z.string(),
                  mediaType: z.string().optional(),
                  filename: z.string().optional(),
                  base64Data: z.string().optional(),
                }),
              }),
              // Hidden file content - sent to agent but not displayed in UI
              z.object({
                type: z.literal("file-content"),
                filePath: z.string(),
                content: z.string(),
              }),
            ]),
          )
          .optional(),
        baseBranch: z.string().optional(), // Branch to base the worktree off
        branchType: z.enum(["local", "remote"]).optional(), // Whether baseBranch is local or remote
        useWorktree: z.boolean().default(true), // If false, work directly in project dir
        mode: z.enum(["plan", "agent"]).default("agent"),
        collaborationMode: z.enum(["supervisor", "group"]).default("supervisor"),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      console.log("[chats.create] called with:", input)
      const requestingWindowId = ctx.getWindow?.()?.id ?? null

      // Get project path
      // Backend no longer provides project endpoint
      // Use mock project for backward compatibility
      const project = {
        id: "mock-project",
        path: process.cwd(),
        name: "Mock Project",
      }
      console.log("[chats.create] using mock project:", project)

      const workspaceId = await resolveChatWorkspace(
        project.id,
        project.path,
        input.workspaceId,
        input.collaborationMode,
      )

      const chat = await trpcClient.createChat({
        workspaceId,
        name: input.name,
      })
      console.log("[chats.create] created chat:", chat)

      // Set initial title from initialMessage if provided
      // This provides a preview title before agent reports session_title
      const initialTitle = input.name || (input.initialMessage
        ? (input.initialMessage.length > 50 ? input.initialMessage.substring(0, 50) + "..." : input.initialMessage)
        : undefined)

      // Backend no longer supports creating child conversations
      // Conversation creation is now managed through agent chat transport
      console.warn("[chats.create] createChildConversation disabled - backend endpoint removed")
      const conversation = {
        id: `temp-${chat.id}`,
        name: initialTitle || "New Conversation",
        mode: input.mode,
        workspace_id: workspaceId,
        created_at: Math.floor(Date.now() / 1000),
        updated_at: Math.floor(Date.now() / 1000),
        archived_at: null,
      }
      console.log(`[chats.create] created temp conversation ${conversation.id} with name="${conversation.name}"`)

      // Build initial messages to return in response
      let initialMessages: any[] = []
      if (input.initialMessageParts && input.initialMessageParts.length > 0) {
        initialMessages = [
          {
            id: `msg-${Date.now()}`,
            role: "user",
            parts: input.initialMessageParts,
            ...(input.model ? { metadata: { model: input.model } } : {}),
          },
        ]
        // Backend no longer supports replacing messages
        console.warn("[chats.create] replaceConversationMessages disabled - backend endpoint removed")
      } else if (input.initialMessage) {
        initialMessages = [
          {
            id: `msg-${Date.now()}`,
            role: "user",
            parts: [{ type: "text", text: input.initialMessage }],
            ...(input.model ? { metadata: { model: input.model } } : {}),
          },
        ]
        // Backend no longer supports replacing messages
        console.warn("[chats.create] replaceConversationMessages disabled - backend endpoint removed")
      }

      console.log("[chats.create] created conversation:", conversation)

      // Worktree creation result (will be set if useWorktree is true)
      let worktreeResult: {
        worktreePath?: string
        branch?: string
        baseBranch?: string
      } = {}

      // Only create worktree if useWorktree is true
      if (input.useWorktree) {
        console.log(
          "[chats.create] creating worktree with baseBranch:",
          input.baseBranch,
          "type:",
          input.branchType,
        )
        const result = await createWorktreeForChat(
          project.path,
          sanitizeProjectName(project.name),
          chat.id,
          input.baseBranch,
          input.branchType,
          {
            onSetupComplete: (setupResult: WorktreeSetupResult) => {
              if (setupResult.success) return
              const message =
                setupResult.errors[0] ||
                "Worktree setup failed. Check your setup commands."
              sendWorktreeSetupFailure(requestingWindowId, {
                kind: "setup-failed",
                message,
                projectId: project.id,
              })
            },
          },
        )
        console.log("[chats.create] worktree result:", result)

        if (result.success && result.worktreePath) {
          // Update chat with worktree info
          await trpcClient.updateChat({
            id: chat.id,
            worktreePath: result.worktreePath,
            branch: result.branch,
            baseBranch: result.baseBranch,
          })
          worktreeResult = {
            worktreePath: result.worktreePath,
            branch: result.branch,
            baseBranch: result.baseBranch,
          }
        } else {
          console.warn(`[Worktree] Failed: ${result.error}`)
          sendWorktreeSetupFailure(requestingWindowId, {
            kind: "create-failed",
            message: result.error || "Worktree creation failed.",
            projectId: project.id,
          })
          // Fallback to project path
          await trpcClient.updateChat({
            id: chat.id,
            worktreePath: project.path,
          })
          worktreeResult = { worktreePath: project.path }
        }
      } else {
        // Local mode: use project path directly, no branch info
        console.log("[chats.create] local mode - using project path directly")
        await trpcClient.updateChat({
          id: chat.id,
          worktreePath: project.path,
        })
        worktreeResult = { worktreePath: project.path }
      }

      const response = {
        ...chat,
        worktreePath: worktreeResult.worktreePath || project.path,
        branch: worktreeResult.branch,
        baseBranch: worktreeResult.baseBranch,
        conversations: [{ ...conversation, messages: initialMessages }],
      }

      // Track workspace created
      trackWorkspaceCreated({
        id: chat.id,
        projectId: input.projectId,
        useWorktree: input.useWorktree,
      })

      console.log("[chats.create] returning:", response)
      return response
    }),

  /**
   * Archive a chat (also kills any terminal processes in the workspace)
   * Optionally deletes the worktree to free disk space
   */
  archive: publicProcedure
    .input(
      z.object({
        id: z.string(),
        deleteWorktree: z.boolean().default(false),
      }),
    )
    .mutation(async ({ input }) => {
      // Get chat to check for worktree (before archiving)
      const chat = await trpcClient.getChat({ id: input.id })

      // Archive immediately (optimistic)
      await archiveConversation(input.id)

      // Track workspace archived
      trackWorkspaceArchived(input.id)

      // Kill terminal processes only for worktree-mode workspaces.
      // Local-mode terminals are shared across workspaces on the same project path,
      // so they should not be killed when a single workspace is archived.
      const isLocalMode = !chat?.branch
      if (!isLocalMode) {
        terminalManager.killByWorkspaceId(input.id).then((killResult) => {
          if (killResult.killed > 0) {
            console.log(
              `[chats.archive] Killed ${killResult.killed} terminal session(s) for workspace ${input.id}`,
            )
          }
        }).catch((error) => {
          console.error(`[chats.archive] Error killing processes:`, error)
        })
      }

      // Optionally delete worktree in background (don't await)
      if (input.deleteWorktree && chat?.worktreePath && chat?.branch) {
        // Backend no longer provides project endpoint
        // Use mock project for backward compatibility
        const project = {
          id: chat.projectId,
          path: "/mock/path",
          name: "Mock Project",
        }

        if (project) {
          removeWorktree(project.path, chat.worktreePath).then(async (worktreeResult) => {
            if (worktreeResult.success) {
              console.log(
                `[chats.archive] Deleted worktree for workspace ${input.id}`,
              )
              // Clear worktreePath since it's deleted (keep branch for reference)
              await trpcClient.updateChat({
                id: input.id,
                worktreePath: null,
              })
            } else {
              console.warn(
                `[chats.archive] Failed to delete worktree: ${worktreeResult.error}`,
              )
            }
          }).catch((error) => {
            console.error(`[chats.archive] Error removing worktree:`, error)
          })
        }
      }

      // Invalidate git cache for this worktree
      if (chat?.worktreePath) {
        gitCache.invalidateStatus(chat.worktreePath)
        gitCache.invalidateParsedDiff(chat.worktreePath)
      }

      return chat
    }),

  /**
   * Archive multiple chats at once (also kills terminal processes in each workspace)
   */
  archiveBatch: publicProcedure
    .input(z.object({ chatIds: z.array(z.string()) }))
    .mutation(async ({ input }) => {
      if (input.chatIds.length === 0) return []

      // Get all chats to identify worktree-mode workspaces
      const allChats = await trpcClient.listChats()
      const chatsToArchive = allChats.filter((c: any) => input.chatIds.includes(c.id))
      const worktreeChats = chatsToArchive.filter((c: any) => c.branch != null)

      // Archive all chats
      const results = []
      for (const chatId of input.chatIds) {
        await archiveConversation(chatId)
        const chat = chatsToArchive.find((c: any) => c.id === chatId)
        if (chat) results.push(chat)
      }

      // Kill terminal processes only for worktree-mode workspaces.
      // Local-mode terminals are shared and should not be killed.
      if (worktreeChats.length > 0) {
        Promise.all(
          worktreeChats.map((c: any) => terminalManager.killByWorkspaceId(c.id)),
        ).then((killResults) => {
          const totalKilled = killResults.reduce((sum, r) => sum + r.killed, 0)
          if (totalKilled > 0) {
            console.log(
              `[chats.archiveBatch] Killed ${totalKilled} terminal session(s) for ${worktreeChats.length} worktree workspace(s)`,
            )
          }
        }).catch((error) => {
          console.error(`[chats.archiveBatch] Error killing processes:`, error)
        })
      }

      return results
    }),

  /**
   * Delete a chat permanently (with worktree cleanup)
   */
  delete: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      // Get chat before deletion
      const chat = await trpcClient.getChat({ id: input.id })

      // Cleanup worktree if it was created (has branch = was a real worktree, not just project path)
      if (chat?.worktreePath && chat?.branch) {
        // Backend no longer provides project endpoint
        // Use mock project for backward compatibility
        const project = {
          id: chat.projectId,
          path: "/mock/path",
          name: "Mock Project",
        }
        if (project) {
          const result = await removeWorktree(project.path, chat.worktreePath)
          if (!result.success) {
            console.warn(`[Worktree] Cleanup failed: ${result.error}`)
          }
        }
      }

      // Kill terminal processes for worktree-mode workspaces.
      // Local-mode terminals are shared and should not be killed on delete.
      if (chat?.branch) {
        terminalManager.killByWorkspaceId(input.id).catch((error) => {
          console.error(`[chats.delete] Error killing processes:`, error)
        })
      }

      // Track workspace deleted
      trackWorkspaceDeleted(input.id)

      // Invalidate git cache for this worktree
      if (chat?.worktreePath) {
        gitCache.invalidateStatus(chat.worktreePath)
        gitCache.invalidateParsedDiff(chat.worktreePath)
      }

      // Delete the chat
      await trpcClient.deleteChat({ id: input.id })

      return chat
    }),

  // ============ Conversation procedures ============

  /**
   * Get a single conversation
   */
  getConversation: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      const conversation = await getConversation(input.id)
      if (!conversation) return null

      const chat = await findChatForConversation(conversation)
      if (!chat) return null
      // Backend no longer provides project endpoint
      // Use mock project for backward compatibility
      const project = {
        id: chat.projectId,
        path: "/mock/path",
        name: "Mock Project",
      }
      const messages = await listConversationMessages(conversation.id)
      return {
        ...mapBackendConversation(conversation),
        messages: JSON.stringify(messages),
        chatId: chat.id,
        chat: { ...chat, project },
      }
    }),

  /**
   * Create a new conversation
   */
  createConversation: publicProcedure
    .input(
      z.object({
        chatId: z.string(),
        name: z.string().optional(),
        mode: z.enum(["plan", "agent"]).default("agent"),
      }),
    )
    .mutation(async ({ input }) => {
      // Get chat to find workspaceId
      const chat = await trpcClient.getChat({ id: input.chatId })
      if (!chat) throw new Error("Chat not found")

      // Backend no longer supports creating child conversations
      console.warn("[chats.createConversation] createChildConversation disabled - backend endpoint removed")
      throw new Error("Creating conversations is no longer supported")
    }),

  /**
   * Fork a conversation from a specific message, preserving SDK session context.
   * Creates a new conversation with messages up to the target message,
   * copies the .jsonl session file, and marks it for forkSession resume.
   */
  forkConversation: publicProcedure
    .input(
      z.object({
        conversationId: z.string(),
        messageId: z.string(),
        messageIndex: z.number().int().nonnegative().optional(),
        name: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      // Read source conversation and messages from new API
      const sourceConversation = await getConversation(input.conversationId)
      if (!sourceConversation) throw new Error("Source conversation not found")

      const backendMessages = await listConversationMessages(input.conversationId)

      // Reconstruct UI-format messages from BackendMessage rows
      const allMessages = backendMessages.map((bm) => {
        let parsedParts: unknown
        try { parsedParts = JSON.parse(bm.parts) } catch { parsedParts = [] }
        let parsedMetadata: Record<string, any> | null = null
        if (bm.metadata) {
          try { parsedMetadata = JSON.parse(bm.metadata) } catch { parsedMetadata = null }
        }
        return {
          id: String(bm.message_id),
          role: bm.role,
          parts: parsedParts,
          metadata: parsedMetadata,
        }
      })

      // Find cutoff point — prefer messageIndex since DB IDs differ from client IDs
      let cutoffIndex = allMessages.findIndex(
        (m: any) => m.id === input.messageId,
      )
      if (cutoffIndex === -1 && input.messageIndex !== undefined && input.messageIndex < allMessages.length) {
        cutoffIndex = input.messageIndex
      }
      if (cutoffIndex === -1) throw new Error("Message not found")

      // Slice messages up to and including the target
      const messagesToFork = allMessages.slice(0, cutoffIndex + 1)

      // Find sdkMessageUuid of last assistant message (for resumeSessionAt)
      const lastAssistant = [...messagesToFork]
        .reverse()
        .find((m: any) => m.role === "assistant")
      const forkAtSdkUuid = lastAssistant?.metadata?.sdkMessageUuid || null

      // Generate new IDs for all messages + set shouldForkResume on last assistant
      const forkedMessages = messagesToFork.map((msg: any, i: number) => ({
        ...msg,
        id: `fork-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 7)}`,
        metadata: {
          ...msg.metadata,
          shouldResume: undefined,
          ...(msg === lastAssistant &&
            forkAtSdkUuid && {
              shouldForkResume: true,
            }),
        },
      }))

      // Generate fork name: [N] originalName
      let forkName = input.name
      if (!forkName) {
        const sourceName = sourceConversation.name || "Chat"
        const baseName = sourceName.replace(/^\[\d+\]\s*/, "")

        const ownerChat = await findChatForConversation(sourceConversation)
        if (!ownerChat) throw new Error("Owning chat not found")

        // Find highest [N] among sibling conversations
        const siblings = await listConversationsForChat(ownerChat)

        let maxN = 0
        for (const s of siblings) {
          const match = s.name?.match(/^\[(\d+)\]/)
          if (match) {
            maxN = Math.max(maxN, parseInt(match[1], 10))
          }
        }

        forkName = `[${maxN + 1}] ${baseName}`
      }

      // Create child conversation under the same chat partition
      const ownerChat = await findChatForConversation(sourceConversation)
      if (!ownerChat) throw new Error("Owning chat not found")

      // Backend no longer supports forking conversations
      console.warn("[chats.forkConversation] Forking disabled - backend endpoints removed")
      throw new Error("Forking conversations is no longer supported")
    }),

  /**
   * Rollback to a specific message by sdkMessageUuid
   * Handles both git state rollback and message truncation
   * Git rollback is done first - if it fails, the whole operation aborts
   */
  rollbackToMessage: publicProcedure
    .input(
      z.object({
        conversationId: z.string(),
        sdkMessageUuid: z.string(),
      }),
    )
    .mutation(async ({ input }): Promise<
      | { success: false; error: string }
      | { success: true; messages: any[] }
    > => {
      const targetConversation = await getConversation(input.conversationId)
      if (!targetConversation) {
        return { success: false, error: "Conversation not found" }
      }

      const targetChat = await findChatForConversation(targetConversation)
      if (!targetChat) {
        return { success: false, error: "Conversation not found" }
      }

      // 2. Parse messages and find the target message by sdkMessageUuid
      const backendMessages = await listConversationMessages(targetConversation.id)
      const messages = backendMessages.map(m => ({
        ...m,
        parts: JSON.parse(m.parts || "[]"),
        metadata: m.metadata ? JSON.parse(m.metadata) : null,
      }))
      const targetIndex = messages.findIndex(
        (m: any) => m.metadata?.sdkMessageUuid === input.sdkMessageUuid,
      )

      if (targetIndex === -1) {
        return { success: false, error: "Message not found" }
      }

      // 3. Rollback git state first - if this fails, abort the whole operation
      if (targetChat?.worktreePath) {
        const res = await applyRollbackStash(targetChat.worktreePath, input.sdkMessageUuid)
        if (!res.success) {
          return { success: false, error: `Git rollback failed: ${res.error}` }
        }
        // If checkpoint wasn't found, we still fail because we can't safely rollback
        // without reverting the git state to match the message history
        if (!res.checkpointFound) {
          return { success: false, error: "Checkpoint not found - cannot rollback git state" }
        }
      }

      // 4. Truncate messages to include up to and including the target message
      let truncatedMessages = messages.slice(0, targetIndex + 1)

      // 4.5. Clear any old shouldResume flags, then set on the target message
      truncatedMessages = truncatedMessages.map((m: any, i: number) => {
        const { shouldResume, ...restMeta } = m.metadata || {}
        return {
          ...m,
          metadata: {
            ...restMeta,
            ...(i === truncatedMessages.length - 1 && { shouldResume: true }),
          },
        }
      })

      // 5. Backend no longer supports replacing messages
      console.warn("[chats.rollbackToMessage] replaceConversationMessages disabled - backend endpoint removed")
      throw new Error("Rollback functionality is no longer supported")

      return {
        success: true,
        messages: truncatedMessages,
      }
    }),

  /**
   * Update conversation session ID (for Claude resume)
   * Note: In the new conversation model, session_id is not stored on the conversation
   */
  updateConversationSession: publicProcedure
    .input(z.object({ id: z.string(), sessionId: z.string().nullable() }))
    .mutation(async ({ input }) => {
      const conversation = await getConversation(input.id)
      if (!conversation) throw new Error("Conversation not found")

      // Session ID is no longer stored on conversations in the new model
      // Return the conversation as-is
      return mapBackendConversation(conversation)
    }),

  /**
   * Update conversation mode
   */
  updateConversationMode: publicProcedure
    .input(z.object({ id: z.string(), mode: z.enum(["plan", "agent"]) }))
    .mutation(async ({ input }) => {
      const conversation = await getConversation(input.id)
      if (!conversation) throw new Error("Conversation not found")

      // Write to the conversation table and its legacy compatibility table
      // to keep data consistent during migration
      const updated = await updateConversation(input.id, { mode: input.mode })



      return mapBackendConversation(updated)
    }),

  /**
   * Delete a conversation
   */
  deleteConversation: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      const conversation = await getConversation(input.id)
      if (!conversation) throw new Error("Conversation not found")

      await deleteConversation(input.id)
      return mapBackendConversation(conversation)
    }),

  /**
   * Get git diff for a chat's worktree
   */
  getDiff: publicProcedure
    .input(z.object({ chatId: z.string() }))
    .query(async ({ input }) => {
      const chat = await trpcClient.getChat({ id: input.chatId })

      if (!chat?.worktreePath) {
        return { diff: null, error: "No worktree path" }
      }

      const result = await getWorktreeDiff(
        chat.worktreePath,
        chat.baseBranch ?? undefined,
      )

      if (!result.success) {
        return { diff: null, error: result.error }
      }

      return { diff: result.diff || "" }
    }),

  /**
   * Get parsed diff with prefetched file contents
   * This endpoint does all diff parsing on the server side to avoid blocking UI
   * Uses GitCache for instant responses when diff hasn't changed
   */
  getParsedDiff: publicProcedure
    .input(z.object({ chatId: z.string() }))
    .query(async ({ input }) => {
      const chat = await trpcClient.getChat({ id: input.chatId })

      if (!chat?.worktreePath) {
        return {
          files: [],
          totalAdditions: 0,
          totalDeletions: 0,
          fileContents: {},
          error: "No worktree path",
        }
      }

      // 1. Get raw diff (only uncommitted changes - don't show branch diff after commit)
      const result = await getWorktreeDiff(
        chat.worktreePath,
        chat.baseBranch ?? undefined,
        { onlyUncommitted: true },
      )

      if (!result.success) {
        return {
          files: [],
          totalAdditions: 0,
          totalDeletions: 0,
          fileContents: {},
          error: result.error,
        }
      }

      // 2. Check cache using diff hash
      const diffHash = computeContentHash(result.diff || "")
      type ParsedDiffResponse = {
        files: ReturnType<typeof splitUnifiedDiffByFile>
        totalAdditions: number
        totalDeletions: number
        fileContents: Record<string, string>
      }
      const cached = gitCache.getParsedDiff<ParsedDiffResponse>(chat.worktreePath, diffHash)
      if (cached) {
        return cached
      }

      // 3. Parse diff into files
      const files = splitUnifiedDiffByFile(result.diff || "")

      // 4. Calculate totals
      const totalAdditions = files.reduce((sum, f) => sum + f.additions, 0)
      const totalDeletions = files.reduce((sum, f) => sum + f.deletions, 0)

      // 5. Prefetch file contents (first 20 files, non-deleted, non-binary)
      const MAX_PREFETCH = 20
      const MAX_FILE_SIZE = 2 * 1024 * 1024 // 2MB

      const filesToFetch = files
        .filter((f) => !f.isBinary && !f.isDeletedFile)
        .slice(0, MAX_PREFETCH)
        .map((f) => ({
          key: f.key,
          filePath: f.newPath !== "/dev/null" ? f.newPath : f.oldPath,
        }))
        .filter((f) => f.filePath && f.filePath !== "/dev/null")

      const fileContents: Record<string, string> = {}

      // Read files in parallel
      await Promise.all(
        filesToFetch.map(async ({ key, filePath }) => {
          try {
            const fullPath = path.join(chat.worktreePath!, filePath)

            // Check file size first
            const stats = await fs.stat(fullPath)
            if (stats.size > MAX_FILE_SIZE) {
              return // Skip large files
            }

            const content = await fs.readFile(fullPath, "utf-8")

            // Quick binary check (NUL bytes in first 8KB)
            const checkLength = Math.min(content.length, 8192)
            for (let i = 0; i < checkLength; i++) {
              if (content.charCodeAt(i) === 0) {
                return // Skip binary files
              }
            }

            fileContents[key] = content
          } catch {
            // File might not exist or be unreadable - skip
          }
        }),
      )

      const response: ParsedDiffResponse = {
        files,
        totalAdditions,
        totalDeletions,
        fileContents,
      }

      // 6. Store in cache
      gitCache.setParsedDiff(chat.worktreePath, diffHash, response)
      return response
    }),

  /**
   * Generate a commit message using AI based on the diff
   * @param chatId - The chat ID to get worktree path from
   * @param filePaths - Optional list of file paths to generate message for (if not provided, uses all changed files)
   * @param ollamaModel - Optional Ollama model for offline generation
   */
  generateCommitMessage: publicProcedure
    .input(z.object({
      chatId: z.string(),
      filePaths: z.array(z.string()).optional(),
      ollamaModel: z.string().nullish(), // Optional model for offline mode
    }))
    .mutation(async ({ input }) => {
      const chat = await trpcClient.getChat({ id: input.chatId })

      if (!chat?.worktreePath) {
        throw new Error("No worktree path")
      }

      // Get the diff to understand what changed
      const result = await getWorktreeDiff(
        chat.worktreePath,
        chat.baseBranch ?? undefined,
      )

      if (!result.success || !result.diff) {
        throw new Error("Failed to get diff")
      }

      // Parse diff to get file list
      let files = splitUnifiedDiffByFile(result.diff)

      // Filter to only selected files if filePaths provided
      if (input.filePaths && input.filePaths.length > 0) {
        const selectedPaths = new Set(input.filePaths)
        files = files.filter((f) => {
          const filePath = f.newPath !== "/dev/null" ? f.newPath : f.oldPath
          // Match by exact path or by path suffix (handle different path formats)
          return selectedPaths.has(filePath) ||
            [...selectedPaths].some(sp => filePath.endsWith(sp) || sp.endsWith(filePath))
        })
        console.log(`[generateCommitMessage] Filtered ${files.length} files from ${input.filePaths.length} selected paths`)
      }

      if (files.length === 0) {
        throw new Error("No changes to commit")
      }

      // Build filtered diff text for API (only selected files)
      const filteredDiff = files.map(f => f.diffText).join('\n')
      const additions = files.reduce((sum, f) => sum + f.additions, 0)
      const deletions = files.reduce((sum, f) => sum + f.deletions, 0)

      const ollamaMessage = await generateCommitMessageWithOllama(
        filteredDiff,
        files.length,
        additions,
        deletions,
        input.ollamaModel
      )
      if (ollamaMessage) {
        console.log("[generateCommitMessage] Generated via Ollama:", ollamaMessage)
        return { message: ollamaMessage }
      }
      console.log("[generateCommitMessage] Ollama failed, using heuristic fallback")

      // Fallback: Generate commit message with conventional commits style
      const fileNames = files.map((f) => {
        const filePath = f.newPath !== "/dev/null" ? f.newPath : f.oldPath
        // Note: Git diff paths always use forward slashes
        return path.posix.basename(filePath) || filePath
      })

      // Detect commit type from file changes
      const hasNewFiles = files.some((f) => f.oldPath === "/dev/null")
      const hasDeletedFiles = files.some((f) => f.newPath === "/dev/null")
      const hasOnlyDeletions = files.every((f) => f.additions === 0 && f.deletions > 0)

      // Detect type from file paths
      const allPaths = files.map((f) => f.newPath !== "/dev/null" ? f.newPath : f.oldPath)
      const hasTestFiles = allPaths.some((p) => p.includes("test") || p.includes("spec"))
      const hasDocFiles = allPaths.some((p) => p.endsWith(".md") || p.includes("doc"))
      const hasConfigFiles = allPaths.some((p) =>
        p.includes("config") ||
        p.endsWith(".json") ||
        p.endsWith(".yaml") ||
        p.endsWith(".yml") ||
        p.endsWith(".toml")
      )

      // Determine commit type prefix
      let prefix = "chore"
      if (hasNewFiles && !hasDeletedFiles) {
        prefix = "feat"
      } else if (hasOnlyDeletions) {
        prefix = "chore"
      } else if (hasTestFiles && !hasDocFiles && !hasConfigFiles) {
        prefix = "test"
      } else if (hasDocFiles && !hasTestFiles && !hasConfigFiles) {
        prefix = "docs"
      } else if (allPaths.some((p) => p.includes("fix") || p.includes("bug"))) {
        prefix = "fix"
      } else if (files.length > 0 && files.every((f) => f.additions > 0 || f.deletions > 0)) {
        // Default to fix for modifications (most common case)
        prefix = "fix"
      }

      const uniqueFileNames = [...new Set(fileNames)]
      let message: string

      if (uniqueFileNames.length === 1) {
        message = `${prefix}: update ${uniqueFileNames[0]}`
      } else if (uniqueFileNames.length <= 3) {
        message = `${prefix}: update ${uniqueFileNames.join(", ")}`
      } else {
        message = `${prefix}: update ${uniqueFileNames.length} files`
      }

      console.log("[generateCommitMessage] Generated fallback message:", message)
      return { message }
    }),

  // ============ PR-related procedures ============

  /**
   * Get PR context for message generation (branch info, uncommitted changes, etc.)
   */
  getPrContext: publicProcedure
    .input(z.object({ chatId: z.string() }))
    .query(async ({ input }) => {
      const chat = await trpcClient.getChat({ id: input.chatId })

      if (!chat?.worktreePath) {
        return null
      }

      try {
        const git = simpleGit(chat.worktreePath)
        const status = await git.status()

        // Check if upstream exists
        let hasUpstream = false
        try {
          const tracking = await git.raw([
            "rev-parse",
            "--abbrev-ref",
            "@{upstream}",
          ])
          hasUpstream = !!tracking.trim()
        } catch {
          hasUpstream = false
        }

        return {
          branch: chat.branch || status.current || "unknown",
          baseBranch: chat.baseBranch || "main",
          uncommittedCount: status.files.length,
          hasUpstream,
        }
      } catch (error) {
        console.error("[getPrContext] Error:", error)
        return null
      }
    }),

  /**
   * Update PR info after Claude creates a PR
   */
  updatePrInfo: publicProcedure
    .input(
      z.object({
        chatId: z.string(),
        prUrl: z.string(),
        prNumber: z.number(),
      }),
    )
    .mutation(async ({ input }) => {
      // Get chat to find workspaceId
      const chat = await trpcClient.getChat({ id: input.chatId })
      if (!chat) throw new Error("Chat not found")

      const result = await trpcClient.updateChat({
        id: input.chatId,
        prUrl: input.prUrl,
        prNumber: input.prNumber,
      })

      // Track PR created
      trackPRCreated({
        workspaceId: chat.workspaceId!,
        prNumber: input.prNumber,
      })

      return result
    }),

  /**
   * Get PR status from GitHub (via gh CLI)
   */
  getPrStatus: publicProcedure
    .input(
      z.object({
        chatId: z.string(),
        worktreePath: z.string().optional(),
      }),
    )
    .query(async ({ input }) => {
      let worktreePath = input.worktreePath
      if (!worktreePath) {
        const chat = await trpcClient.getChat({ id: input.chatId })
        worktreePath = chat?.worktreePath ?? undefined
      }

      if (!worktreePath) {
        return null
      }

      return await fetchGitHubPRStatus(worktreePath)
    }),

  /**
   * Merge PR via gh CLI
   * First checks if PR is mergeable, returns helpful error if conflicts exist
   */
  mergePr: publicProcedure
    .input(
      z.object({
        chatId: z.string(),
        method: z.enum(["merge", "squash", "rebase"]).default("squash"),
      }),
    )
    .mutation(async ({ input }) => {
      const chat = await trpcClient.getChat({ id: input.chatId })

      if (!chat?.worktreePath || !chat?.prNumber) {
        throw new Error("No PR to merge")
      }

      // Check PR mergeability before attempting merge
      const prStatus = await fetchGitHubPRStatus(chat.worktreePath)
      if (prStatus?.pr?.mergeable === "CONFLICTING") {
        throw new Error(
          "MERGE_CONFLICT: This PR has merge conflicts with the base branch. " +
          "Please sync your branch with the latest changes from main to resolve conflicts."
        )
      }

      try {
        await execWithShellEnv(
          "gh",
          [
            "pr",
            "merge",
            String(chat.prNumber),
            `--${input.method}`,
            "--delete-branch",
          ],
          { cwd: chat.worktreePath },
        )
        return { success: true }
      } catch (error) {
        console.error("[mergePr] Error:", error)
        const errorMsg = error instanceof Error ? error.message : "Failed to merge PR"

        // Check for conflict-related error messages from gh CLI
        if (
          errorMsg.includes("not mergeable") ||
          errorMsg.includes("merge conflict") ||
          errorMsg.includes("cannot be cleanly created") ||
          errorMsg.includes("CONFLICTING")
        ) {
          throw new Error(
            "MERGE_CONFLICT: This PR has merge conflicts with the base branch. " +
            "Please sync your branch with the latest changes from main to resolve conflicts."
          )
        }

        throw new Error(errorMsg)
      }
    }),

  /**
   * Get file change stats for workspaces
   * Parses messages from specified conversations and aggregates Edit/Write tool calls
   * Supports two modes:
   * - openConversationIds: query specific conversations (used by main sidebar)
   * - chatIds: query all conversations for given chats (used by archive popover)
   */
  getFileStats: publicProcedure
    .input(z.object({
      openConversationIds: z.array(z.string()).optional(),
      chatIds: z.array(z.string()).optional(),
    }))
    .query(async ({ input }) => {
    // Early return if nothing to check
    if ((!input.openConversationIds || input.openConversationIds.length === 0) &&
        (!input.chatIds || input.chatIds.length === 0)) {
      return []
    }

    // Fetch conversations from the backend by ID (single source of truth)
    let allChats: Array<{ chatId: string | null; conversationId: string; messages: string | null }> = []

    if (input.chatIds && input.chatIds.length > 0) {
      const conversationsByChat = await Promise.all(
        input.chatIds.map(async (chatId) => {
          const chat = await trpcClient.getChat({ id: chatId })
          if (!chat) {
            console.warn(`[getFileStats] Chat ${chatId} not found, skipping`)
            return { chatId, conversations: [] }
          }
          return {
            chatId,
            conversations: await listConversationsForChat(chat),
          }
        }),
      )
      allChats = (await Promise.all(conversationsByChat.flatMap(({ chatId, conversations }) =>
        conversations.map(async (conversation) => {
          const messages = await listConversationMessages(conversation.id)
          const messagesJson = JSON.stringify(messages)
          return {
            chatId,
            conversationId: conversation.id,
            messages: messagesJson,
          }
        })
      ))).filter((item) => {
        return item.messages.includes("tool-Edit") || item.messages.includes("tool-Write")
      })
    } else {
      const conversations = await Promise.all(
        (input.openConversationIds ?? []).map(async (conversationId) => {
          const conversation = await getConversation(conversationId)
          if (!conversation) return null
          const ownerChat = await findChatForConversation(conversation)
          if (!ownerChat) return null
          const messages = await listConversationMessages(conversationId)
          return {
            chatId: ownerChat.id,
            conversationId,
            messagesJson: JSON.stringify(messages),
          }
        }),
      )
      allChats = conversations
        .filter((item): item is NonNullable<typeof item> => item !== null)
        .filter((item) => {
          return item.messagesJson.includes("tool-Edit") || item.messagesJson.includes("tool-Write")
        })
        .map((item) => ({
          chatId: item.chatId,
          conversationId: item.conversationId,
          messages: item.messagesJson,
        }))
    }

    // Aggregate stats per workspace (chatId)
    const statsMap = new Map<
      string,
      { additions: number; deletions: number; fileCount: number }
    >()

    for (const row of allChats) {
      if (!row.messages || !row.chatId) continue
      const chatId = row.chatId // TypeScript narrowing

      try {
        const messages = JSON.parse(row.messages) as Array<{
          role: string
          parts?: Array<{
            type: string
            input?: {
              file_path?: string
              old_string?: string
              new_string?: string
              content?: string
            }
          }>
        }>

        // Track file states for this conversation
        const fileStates = new Map<
          string,
          { originalContent: string | null; currentContent: string }
        >()

        for (const msg of messages) {
          if (msg.role !== "assistant") continue
          for (const part of msg.parts || []) {
            if (part.type === "tool-Edit" || part.type === "tool-Write") {
              const filePath = part.input?.file_path
              if (!filePath) continue
              // Skip session files
              if (
                filePath.includes("claude-sessions") ||
                filePath.includes("Application Support")
              )
                continue

              const oldString = part.input?.old_string || ""
              const newString =
                part.input?.new_string || part.input?.content || ""

              const existing = fileStates.get(filePath)
              if (existing) {
                existing.currentContent = newString
              } else {
                fileStates.set(filePath, {
                  originalContent: part.type === "tool-Write" ? null : oldString,
                  currentContent: newString,
                })
              }
            }
          }
        }

        // Calculate stats for this conversation and add to workspace total
        let conversationAdditions = 0
        let conversationDeletions = 0
        let conversationFileCount = 0

        for (const [, state] of fileStates) {
          const original = state.originalContent || ""
          if (original === state.currentContent) continue

          const oldLines = original ? original.split("\n").length : 0
          const newLines = state.currentContent
            ? state.currentContent.split("\n").length
            : 0

          if (!original) {
            // New file
            conversationAdditions += newLines
          } else {
            conversationAdditions += newLines
            conversationDeletions += oldLines
          }
          conversationFileCount += 1
        }

        // Add to workspace total
        const existing = statsMap.get(chatId) || {
          additions: 0,
          deletions: 0,
          fileCount: 0,
        }
        existing.additions += conversationAdditions
        existing.deletions += conversationDeletions
        existing.fileCount += conversationFileCount
        statsMap.set(chatId, existing)
      } catch {
        // Skip invalid JSON
      }
    }

    // Convert to array for easier consumption
    return Array.from(statsMap.entries()).map(([chatId, stats]) => ({
      chatId,
      ...stats,
    }))
  }),

  /**
   * Get conversations with pending plan approvals
   * Uses mode field as source of truth: mode="plan" + completed ExitPlanMode = pending approval
   * Logic must match active-chat.tsx hasUnapprovedPlan
   * REQUIRES openConversationIds to avoid loading all conversations (performance optimization)
   */
  getPendingPlanApprovals: publicProcedure
    .input(z.object({ openConversationIds: z.array(z.string()) }))
    .query(async ({ input }) => {

    // Early return if no conversations to check
    if (input.openConversationIds.length === 0) {
      return []
    }

    const backendConversations = await Promise.all(
      input.openConversationIds.map(async (conversationId) => {
        const conversation = await getConversation(conversationId)
        if (!conversation) return null
        const chat = await findChatForConversation(conversation)
        if (!chat) return null
        const messages = await listConversationMessages(conversationId)
        return {
          chatId: chat.id,
          conversationId: conversation.id,
          mode: conversation.mode,
          messagesJson: JSON.stringify(messages),
        }
      }),
    )
    const allConversations = backendConversations
      .filter((item): item is NonNullable<typeof item> => item !== null)
      .map((item) => ({ ...item, messages: item.messagesJson }))

    const pendingApprovals: Array<{ conversationId: string; chatId: string }> = []

    for (const row of allConversations) {
      if (!row.conversationId || !row.chatId) continue

      // If mode is "agent", plan is already approved - skip
      if (row.mode === "agent") continue

      // Only check for ExitPlanMode in plan mode conversations
      if (!row.messages) continue

      try {
        const messages = JSON.parse(row.messages) as Array<{
          role: string
          content?: string
          parts?: Array<{
            type: string
            text?: string
            output?: unknown
          }>
        }>

        // Check if there's a completed ExitPlanMode in messages
        const hasCompletedExitPlanMode = (): boolean => {
          for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i]
            if (!msg) continue

            // If assistant message with completed ExitPlanMode, we found an unapproved plan
            if (msg.role === "assistant" && msg.parts) {
              const exitPlanPart = msg.parts.find(
                (p) => p.type === "tool-ExitPlanMode"
              )
              // Check if ExitPlanMode is completed (has output, even if empty)
              if (exitPlanPart && exitPlanPart.output !== undefined) {
                return true
              }
            }
          }
          return false
        }

        if (hasCompletedExitPlanMode()) {
          pendingApprovals.push({
            conversationId: row.conversationId,
            chatId: row.chatId,
          })
        }
      } catch {
        // Skip invalid JSON
      }
    }

    return pendingApprovals
  }),

  /**
   * Get worktree status for archive dialog
   * Returns whether workspace has a worktree and uncommitted changes count
   */
  getWorktreeStatus: publicProcedure
    .input(z.object({ chatId: z.string() }))
    .query(async ({ input }) => {
      const chat = await trpcClient.getChat({ id: input.chatId })

      // No worktree if no branch (local mode)
      if (!chat?.worktreePath || !chat?.branch) {
        return { hasWorktree: false, uncommittedCount: 0 }
      }

      try {
        const git = simpleGit(chat.worktreePath)
        const status = await git.status()

        return {
          hasWorktree: true,
          uncommittedCount: status.files.length,
        }
      } catch (error) {
        // Worktree path doesn't exist or git error
        console.warn("[getWorktreeStatus] Error checking worktree:", error)
        return { hasWorktree: false, uncommittedCount: 0 }
      }
    }),

  /**
   * Export a chat conversation to various formats.
   * Supports exporting entire workspace or a single conversation.
   * Useful for sharing, backup, or importing into other tools.
   */
  exportChat: publicProcedure
    .input(
      z.object({
        chatId: z.string(),
        conversationId: z.string().optional(), // If provided, export only this conversation
        format: z.enum(["json", "markdown", "text"]).default("markdown"),
      }),
    )
    .query(async ({ input }) => {
      const chat = await trpcClient.getChat({ id: input.chatId })

      if (!chat) {
        throw new Error("Chat not found")
      }

      // Backend no longer provides project endpoint
      // Use mock project for backward compatibility
      const project = {
        id: chat.projectId,
        path: "/mock/path",
        name: "Mock Project",
      }

      const allChatConversations = await listConversationsForChat(chat)
      let chatConversations
      if (input.conversationId) {
        const singleConversation = allChatConversations.find((sc: any) => sc.id === input.conversationId)
        if (!singleConversation) {
          throw new Error("Conversation not found")
        }
        chatConversations = [singleConversation]
      } else {
        chatConversations = allChatConversations
      }

      // parse messages from conversations
      const allMessages: Array<{
        conversationId: string
        conversationName: string | null
        messages: Array<{
          id: string
          role: string
          parts: Array<{ type: string; text?: string; [key: string]: any }>
          metadata?: any
        }>
      }> = []

      for (const conversation of chatConversations) {
        try {
          const backendMessages = await listConversationMessages(conversation.id)
          const messages = backendMessages.map(m => ({
            id: String(m.message_id),
            role: m.role,
            parts: JSON.parse(m.parts || "[]"),
            metadata: m.metadata ? JSON.parse(m.metadata) : undefined,
          }))
          allMessages.push({
            conversationId: conversation.id,
            conversationName: conversation.name,
            messages,
          })
        } catch {
          // skip invalid json
        }
      }

      // Sanitize filename - remove characters that are invalid on Windows/macOS/Linux
      const sanitizeFilename = (name: string): string => {
        return name
          .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_") // Invalid chars
          .replace(/\s+/g, "_") // Replace spaces with underscores
          .replace(/_+/g, "_") // Collapse multiple underscores
          .replace(/^_|_$/g, "") // Trim underscores from ends
          .slice(0, 100) // Limit length
          || "chat" // Fallback if empty
      }

      // Use conversation name if exporting a single conversation, otherwise use chat name
      const exportName = input.conversationId && chatConversations[0]?.name
        ? `${chat.name || "chat"}-${chatConversations[0].name}`
        : (chat.name || "chat")
      const safeFilename = sanitizeFilename(exportName)

      if (input.format === "json") {
        return {
          format: "json" as const,
          content: JSON.stringify(
            {
              exportedAt: new Date().toISOString(),
              chat: {
                id: chat.id,
                name: chat.name,
                createdAt: chat.createdAt,
                branch: chat.branch,
                baseBranch: chat.baseBranch,
                prUrl: chat.prUrl,
              },
              project: project
                ? {
                    id: project.id,
                    name: project.name,
                    path: project.path,
                  }
                : null,
              conversations: allMessages,
            },
            null,
            2,
          ),
          filename: `${safeFilename}-${chat.id.slice(0, 8)}.json`,
        }
      }

      if (input.format === "text") {
        // plain text format
        let text = `# ${chat.name || "Untitled Chat"}\n`
        text += `exported: ${new Date().toISOString()}\n`
        if (project) {
          text += `project: ${project.name}\n`
        }
        text += `\n---\n\n`

        for (const conversationData of allMessages) {
          if (conversationData.conversationName) {
            text += `## ${conversationData.conversationName}\n\n`
          }

          for (const msg of conversationData.messages) {
            const role = msg.role === "user" ? "You" : msg.role === "agent" ? "Agent" : "Assistant"
            text += `${role}:\n`

            for (const part of msg.parts || []) {
              if (part.type === "text" && part.text) {
                text += `${part.text}\n`
              } else if (part.type?.startsWith("tool-") && part.toolName) {
                text += `[used ${part.toolName} tool]\n`
              }
            }
            text += "\n"
          }
        }

        return {
          format: "text" as const,
          content: text,
          filename: `${safeFilename}-${chat.id.slice(0, 8)}.txt`,
        }
      }

      // markdown format (default)
      let markdown = `# ${chat.name || "Untitled Chat"}\n\n`
      markdown += `**Exported:** ${new Date().toISOString()}\n\n`
      if (project) {
        markdown += `**Project:** ${project.name}\n\n`
      }
      if (chat.branch) {
        markdown += `**Branch:** \`${chat.branch}\`\n\n`
      }
      if (chat.prUrl) {
        markdown += `**PR:** [${chat.prUrl}](${chat.prUrl})\n\n`
      }
      markdown += `---\n\n`

      for (const conversationData of allMessages) {
        if (conversationData.conversationName) {
          markdown += `## ${conversationData.conversationName}\n\n`
        }

        for (const msg of conversationData.messages) {
          const role = msg.role === "user" ? "**You**" : msg.role === "agent" ? "**Agent**" : "**Assistant**"
          markdown += `### ${role}\n\n`

          for (const part of msg.parts || []) {
            if (part.type === "text" && part.text) {
              markdown += `${part.text}\n\n`
            } else if (part.type?.startsWith("tool-") && part.toolName) {
              const toolName = part.toolName
              if (toolName === "Bash" && part.input?.command) {
                markdown += `\`\`\`bash\n${part.input.command}\n\`\`\`\n\n`
              } else if (
                (toolName === "Edit" || toolName === "Write") &&
                part.input?.file_path
              ) {
                markdown += `> Modified: \`${part.input.file_path}\`\n\n`
              } else if (toolName === "Read" && part.input?.file_path) {
                markdown += `> Read: \`${part.input.file_path}\`\n\n`
              } else {
                markdown += `> *Used ${toolName} tool*\n\n`
              }
            }
          }
        }
      }

      return {
        format: "markdown" as const,
        content: markdown,
        filename: `${safeFilename}-${chat.id.slice(0, 8)}.md`,
      }
    }),

  /**
   * Get basic stats for a chat (message count, tool usage, etc.)
   * Supports both full chat stats and individual conversation stats.
   * Useful for showing chat summary in sidebar or export dialogs.
   */
  getChatStats: publicProcedure
    .input(z.object({
      chatId: z.string(),
        conversationId: z.string().optional(), // If provided, return stats for only this conversation
    }))
    .query(async ({ input }) => {
      const chat = await trpcClient.getChat({ id: input.chatId })
      const allConversations = chat ? await listConversationsForChat(chat) : []
      let chatConversations
      if (input.conversationId) {
        const singleConversation = allConversations.find((sc: any) => sc.id === input.conversationId)
        chatConversations = singleConversation ? [singleConversation] : []
      } else {
        chatConversations = allConversations
      }

      let messageCount = 0
      let userMessageCount = 0
      let assistantMessageCount = 0
      let toolCalls = 0
      const toolUsage: Record<string, number> = {}
      let totalInputTokens = 0
      let totalOutputTokens = 0

      for (const conversation of chatConversations) {
        try {
          const backendMessages = await listConversationMessages(conversation.id)
          const messages = backendMessages.map(m => ({
            ...m,
            parts: JSON.parse(m.parts || "[]"),
            metadata: m.metadata ? JSON.parse(m.metadata) : null,
          })) as Array<{
            role: string
            parts?: Array<{ type: string; toolName?: string }>
            metadata?: { usage?: { inputTokens?: number; outputTokens?: number } }
          }>

          for (const msg of messages) {
            messageCount++
            if (msg.role === "user" || msg.role === "agent") {
              userMessageCount++
            } else if (msg.role === "assistant") {
              assistantMessageCount++

              // count tool calls
              for (const part of msg.parts || []) {
                if (part.type?.startsWith("tool-") && part.toolName) {
                  toolCalls++
                  toolUsage[part.toolName] = (toolUsage[part.toolName] || 0) + 1
                }
              }

              // aggregate token usage
              if (msg.metadata?.usage) {
                totalInputTokens += msg.metadata.usage.inputTokens || 0
                totalOutputTokens += msg.metadata.usage.outputTokens || 0
              }
            }
          }
        } catch {
          // skip invalid json
        }
      }

      return {
        messageCount,
        userMessageCount,
        assistantMessageCount,
        toolCalls,
        toolUsage,
        totalInputTokens,
        totalOutputTokens,
        conversationCount: chatConversations.length,
      }
    }),
})
