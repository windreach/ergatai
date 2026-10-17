import { useCallback, useRef } from "react"
import { trpc, trpcClient } from "../../../lib/trpc"
import { toast } from "sonner"
import { useAgentConversationStore } from "../stores/conversation-store"
import { useMessageQueueStore } from "../stores/message-queue-store"
import { getQueryClient } from "../../../contexts/TRPCProvider"
import { MENTION_PREFIXES } from "../../mentions/types"
import { utf8ToBase64 } from "../utils/base64"
import { extractAgentMentions } from "../collaboration/implicit-collaboration"
import { getCoreAgentProfileName } from "../lib/agent-contract-api"
import type { CoreAgentOption } from "../types"
import type { GroupAgentRuntimeStatuses } from "../collaboration/group-agent-runtime"
import {
  createQueueItem,
  generateQueueId,
  toQueuedImage,
  toQueuedFile,
  toQueuedTextContext,
  toQueuedDiffTextContext,
  toQueuedPastedText,
} from "../lib/queue-utils"
import { waitForStreamingReady } from "../utils/stream-utils"

interface UseMessageSendingOptions {
  // 会话信息
  conversation: {
    id: string
    parentChatId: string | null
    mode: string
    isArchived: boolean
  }

  // 工作区配置
  workspace: {
    sandboxSetupStatus: string
    isGroupMode: boolean
    teamId: string | null
    projectPath: string | null
    workspaceId: string | null
    provider: string
  }

  // 协作功能
  collaboration: {
    session: any
    enabled: boolean
    groupAgents: CoreAgentOption[]
  }

  // 输入和附件 refs
  inputRefs: {
    editor: React.RefObject<any>
    images: React.RefObject<any[]>
    files: React.RefObject<any[]>
    textContexts: React.RefObject<any[]>
    diffTextContexts: React.RefObject<any[]>
    pastedTexts: React.RefObject<any[]>
    fileContents: React.RefObject<Map<string, string>>
    isStreaming: React.RefObject<boolean>
  }

  // 回调函数
  actions: {
    scrollToBottom: () => void
    onRestoreWorkspace?: () => void
    clearAll: () => void
    clearTextContexts: () => void
    clearDiffTextContexts: () => void
    clearPastedTexts: () => void
    clearFileContents: () => void
    clearConversationDraft: (parentChatId: string, conversationId: string) => void
  }

  // 队列管理
  queue: {
    addToQueue: (conversationId: string, item: any) => void
    popItemFromQueue: (conversationId: string, itemId: string) => any
    removeFromQueue: (conversationId: string, itemId: string) => void
  }

  // 消息处理
  messaging: {
    handleStop: () => Promise<void>
    sendMessageRef: React.RefObject<(message: any) => Promise<void>>
    setMessages: (messages: any[] | ((current: any[]) => any[])) => void
    setExpiredQuestionsMap: (updater: (current: Map<string, any>) => Map<string, any>) => void
    setGroupAgentRuntimeStatuses: (chatId: string, statuses: GroupAgentRuntimeStatuses) => void
    trackMessageSent: (data: any) => void
    submitImplicitInteraction: (text: string) => void
  }
}

export function useMessageSending({
  conversation,
  workspace,
  collaboration,
  inputRefs,
  actions,
  queue,
  messaging,
}: UseMessageSendingOptions) {
  // Get tRPC utils for optimistic updates
  const utils = trpc.useUtils()
  const utilsRef = useRef(utils)
  utilsRef.current = utils

  // Refs for handleSend to avoid recreating callback on every messages change
  const messagesLengthRef = useRef(0)
  const conversationModeRef = useRef(conversation.mode)
  conversationModeRef.current = conversation.mode
  const imagesRefLocal = useRef(inputRefs.images.current)
  imagesRefLocal.current = inputRefs.images.current
  const filesRefLocal = useRef(inputRefs.files.current)
  filesRefLocal.current = inputRefs.files.current

  // Refs for callback groups to avoid stale closures and dependency array bloat
  const actionsRef = useRef(actions)
  const messagingRef = useRef(messaging)
  const queueRef = useRef(queue)
  const inputRefsRef = useRef(inputRefs)
  const workspaceRef = useRef(workspace)
  const conversationRef = useRef(conversation)
  const collaborationRef = useRef(collaboration)

  // Sync refs on every render (not in useEffect) so callbacks always have latest values
  // This is the recommended pattern for "latest value" refs
  actionsRef.current = actions
  messagingRef.current = messaging
  queueRef.current = queue
  inputRefsRef.current = inputRefs
  workspaceRef.current = workspace
  conversationRef.current = conversation
  collaborationRef.current = collaboration

  const handleSend = useCallback(async () => {
    // Block sending while sandbox is still being set up
    if (workspaceRef.current.sandboxSetupStatus !== "ready") {
      console.warn("[ChatSend] Blocked: sandbox is not ready", {
        conversationId: conversationRef.current.id,
        sandboxSetupStatus: workspaceRef.current.sandboxSetupStatus,
      })
      return
    }

    // Clear any expired questions when user sends a new message
    messagingRef.current.setExpiredQuestionsMap((current) => {
      if (current.has(conversationRef.current.id)) {
        const newMap = new Map(current)
        newMap.delete(conversationRef.current.id)
        return newMap
      }
      return current
    })

    // Get value from uncontrolled editor
    const inputValue = inputRefsRef.current.editor.current?.getValue() || ""
    const hasText = inputValue.trim().length > 0
    const currentImages = imagesRefLocal.current
    const currentFiles = filesRefLocal.current
    const currentTextContexts = inputRefsRef.current.textContexts.current
    const currentDiffTextContexts = inputRefsRef.current.diffTextContexts.current
    const currentPastedTexts = inputRefsRef.current.pastedTexts.current
    const hasImages =
      currentImages.filter((img) => !img.isLoading && img.url).length > 0
    const hasTextContexts = currentTextContexts.length > 0
    const hasDiffTextContexts = currentDiffTextContexts.length > 0
    const hasPastedTexts = currentPastedTexts.length > 0

    if (!hasText && !hasImages && !hasTextContexts && !hasDiffTextContexts && !hasPastedTexts) return

    // If streaming, add to queue instead of sending directly
    if (inputRefsRef.current.isStreaming.current) {
      const queuedImages = currentImages
        .filter((img) => !img.isLoading && img.url)
        .map(toQueuedImage)
      const queuedFiles = currentFiles
        .filter((f) => !f.isLoading && f.url)
        .map(toQueuedFile)
      const queuedTextContexts = currentTextContexts.map(toQueuedTextContext)
      const queuedDiffTextContexts = currentDiffTextContexts.map(toQueuedDiffTextContext)
      const queuedPastedTexts = currentPastedTexts.map(toQueuedPastedText)

      const item = createQueueItem(
        generateQueueId(),
        inputValue.trim(),
        queuedImages.length > 0 ? queuedImages : undefined,
        queuedFiles.length > 0 ? queuedFiles : undefined,
        queuedTextContexts.length > 0 ? queuedTextContexts : undefined,
        queuedDiffTextContexts.length > 0 ? queuedDiffTextContexts : undefined,
        queuedPastedTexts.length > 0 ? queuedPastedTexts : undefined,
      )
      queueRef.current.addToQueue(conversationRef.current.id, item)

      // Clear input and attachments
      inputRefsRef.current.editor.current?.clear()
      if (conversationRef.current.parentChatId) {
        actionsRef.current.clearConversationDraft(conversationRef.current.parentChatId, conversationRef.current.id)
      }
      actionsRef.current.clearAll()
      actionsRef.current.clearTextContexts()
      actionsRef.current.clearDiffTextContexts()
      actionsRef.current.clearPastedTexts()
      return
    }

    // Auto-restore archived workspace when sending a message
    if (conversationRef.current.isArchived && actionsRef.current.onRestoreWorkspace) {
      actionsRef.current.onRestoreWorkspace()
    }

    const text = inputValue.trim()

    // Clear editor and draft from localStorage
    inputRefsRef.current.editor.current?.clear()
    if (conversationRef.current.parentChatId) {
      actionsRef.current.clearConversationDraft(conversationRef.current.parentChatId, conversationRef.current.id)
    }

    // Track message sent
    messagingRef.current.trackMessageSent({
      workspaceId: conversationRef.current.id,
      messageLength: text.length,
      mode: conversationModeRef.current,
    })

    // Build message parts: images first, then files, then text
    // Include base64Data for API transmission
    const parts: any[] = [
      ...currentImages
        .filter((img) => !img.isLoading && img.url)
        .map((img) => ({
          type: "data-image" as const,
          data: {
            url: img.url,
            mediaType: img.mediaType,
            filename: img.filename,
            base64Data: img.base64Data, // Include base64 data for Claude API
          },
        })),
      ...currentFiles
        .filter((f) => !f.isLoading && f.url)
        .map((f) => ({
          type: "data-file" as const,
          data: {
            url: f.url,
            mediaType: (f as any).mediaType,
            filename: f.filename,
            size: f.size,
          },
        })),
    ]

    // Add text contexts as mention tokens
    let mentionPrefix = ""

    if (currentTextContexts.length > 0 || currentDiffTextContexts.length > 0 || currentPastedTexts.length > 0) {
      const quoteMentions = currentTextContexts.map((tc) => {
        const preview = tc.preview.replace(/[:\[\]]/g, "") // Sanitize preview
        const encodedText = utf8ToBase64(tc.text) // Base64 encode full text
        return `@[${MENTION_PREFIXES.QUOTE}${preview}:${encodedText}]`
      })

      const diffMentions = currentDiffTextContexts.map((dtc) => {
        const preview = dtc.preview.replace(/[:\[\]]/g, "") // Sanitize preview
        const encodedText = utf8ToBase64(dtc.text) // Base64 encode full text
        const lineNum = dtc.lineNumber || 0
        return `@[${MENTION_PREFIXES.DIFF}${dtc.filePath}:${lineNum}:${preview}:${encodedText}]`
      })

      // Add pasted text / chat history as mentions (format: prefix:size:preview|filepath)
      // Using | as separator since filepath can contain colons
      const pastedTextMentions = currentPastedTexts.map((pt) => {
        const sanitizedPreview = pt.preview.replace(/[:\[\]|]/g, "")
        const prefix = pt.kind === "chatHistory" ? MENTION_PREFIXES.CHAT_HISTORY : MENTION_PREFIXES.PASTED
        return `@[${prefix}${pt.size}:${sanitizedPreview}|${pt.filePath}]`
      })

      mentionPrefix = [...quoteMentions, ...diffMentions, ...pastedTextMentions].join(" ") + " "
    }

    if (text || mentionPrefix) {
      parts.push({ type: "text", text: mentionPrefix + (text || "") })
    }

    // Add cached file contents as hidden parts (sent to agent but not displayed in UI)
    // These are from dropped text files - content is embedded so agent sees it immediately
    if (inputRefsRef.current.fileContents.current.size > 0) {
      for (const [mentionId, content] of inputRefsRef.current.fileContents.current.entries()) {
        // Extract file path from mentionId (file:local:path or file:external:path)
        const filePath = mentionId.replace(/^file:(local|external):/, "")
        parts.push({
          type: "file-content",
          filePath,
          content,
        })
      }
    }

    if (workspaceRef.current.isGroupMode) {
      const parentChatId = conversationRef.current.parentChatId
      if (!parentChatId) {
        console.warn("[GroupChat] Cannot send message: parentChatId is not set")
        toast.error("Group chat is not initialized")
        return
      }
      const agentMentionPattern = /@\[agent:([^\]]+)\]/g
      const mentionedAgents = Array.from(
        new Set(
          Array.from<RegExpMatchArray>(text.matchAll(agentMentionPattern)).map(
            (match) => match[1],
          ),
        ),
      )

      if (mentionedAgents.length > 0) {
        const targets = mentionedAgents
          .map(
            (mentionedName) =>
              collaborationRef.current.groupAgents.find(
                (agent) =>
                  agent.name.toLowerCase() === mentionedName.toLowerCase() ||
                  agent.id === mentionedName ||
                  getCoreAgentProfileName(agent) === mentionedName,
              ),
          )
          .filter((agent): agent is CoreAgentOption => Boolean(agent))

        if (targets.length !== mentionedAgents.length) {
          toast.error("One or more mentioned agents are not in this group")
          return
        }

        const message = text
          .replace(/@\[agent:([^\]]+)\]/g, "")
          .replace(mentionPrefix, "")
          .trim()
        const imageParts = parts.filter(
          (part) => part.type === "data-image" && part.data?.base64Data,
        )
        const images = imageParts.map((part) => ({
          base64Data: part.data.base64Data,
          mediaType: part.data.mediaType,
          filename: part.data.filename,
        }))
        const groupParts = [
          ...imageParts,
          ...(message ? [{ type: "text", text: message }] : []),
        ]
        const messageId = `group-user-${Date.now()}-${Math.random()
          .toString(36)
          .slice(2, 8)}`
        const acknowledgedMessages = targets.map((target, index) => ({
          id: `${messageId}-ack-${target.id}-${index}`,
          role: "assistant",
          metadata: {
            agentId: target.id,
            agentName: target.name,
          },
          parts: [{ type: "text", text: "收到" }],
        }))

        inputRefsRef.current.editor.current?.clear()
        if (conversationRef.current.parentChatId) {
          actionsRef.current.clearConversationDraft(conversationRef.current.parentChatId, conversationRef.current.id)
        }
        actionsRef.current.clearAll()
        actionsRef.current.clearTextContexts()
        actionsRef.current.clearDiffTextContexts()
        actionsRef.current.clearPastedTexts()
        actionsRef.current.clearFileContents()

        messagingRef.current.setGroupAgentRuntimeStatuses(
          parentChatId,
          Object.fromEntries(
            targets.map((target) => [target.id, "running"]),
          ) as GroupAgentRuntimeStatuses,
        )
        messagingRef.current.setMessages((current: any) => [
          ...current,
          { id: messageId, role: "user", parts: groupParts },
          ...acknowledgedMessages,
        ])
        actionsRef.current.scrollToBottom()

        if (collaborationRef.current.enabled) {
          try {
            const sessionResult = await collaborationRef.current.session.submitInteraction({
              text: message,
              kind: "message",
              mentionedAgentIds: targets.map((target) => target.id),
              selectedAgentIds: targets.map((target) => target.id),
              metadata: {
                targetNames: targets.map((target) => target.name),
              },
            })

            if (sessionResult.route === "collaboration") {
              return
            }
          } catch (error) {
            console.warn(
              "[CollaborationSession] Group submission failed; using direct dispatch",
              error,
            )
          }
        }

        messagingRef.current.submitImplicitInteraction(text)

        const correlationId = `group-${Date.now()}-${Math.random()
          .toString(36)
          .slice(2, 8)}`
        targets.forEach((target) => {
          void (async () => {
            await trpcClient.groupChat.addMember.mutate({
              chatId: parentChatId,
              agentCommand: getCoreAgentProfileName(target),
              agentName: target.name,
              workspaceId: workspaceRef.current.projectPath || undefined,
            })
            await trpcClient.groupChat.sendToAgent.mutate({
              chatId: parentChatId,
              agentCommand: getCoreAgentProfileName(target),
              message,
              correlationId,
              images,
            })
          })().catch((error) => {
              messagingRef.current.setGroupAgentRuntimeStatuses(parentChatId, {
                [target.id]: "failed",
              })
              console.error("[GroupChat] Failed to dispatch mentioned message:", error)
              toast.error(
                error instanceof Error ? error.message : "Failed to send to agent",
              )
          })
        })

        return
      }

      toast.error("Group chat messages must mention an agent")
      return
    }

    actionsRef.current.clearAll()
    actionsRef.current.clearTextContexts()
    actionsRef.current.clearDiffTextContexts()
    actionsRef.current.clearPastedTexts()
    actionsRef.current.clearFileContents()

    // Optimistic update: immediately update chat's updated_at and resort array for instant sidebar resorting
    // NOTE: agents.getAgentChats procedure was removed; desktop app uses chats.list below instead.

    // Desktop app: Optimistic update for chats.list to update sidebar immediately
    const queryClient = getQueryClient()
    if (queryClient) {
      const now = new Date()
      const queries = queryClient.getQueryCache().getAll()
      const chatsListQuery = queries.find(q =>
        Array.isArray(q.queryKey) &&
        Array.isArray(q.queryKey[0]) &&
        q.queryKey[0][0] === 'chats' &&
        q.queryKey[0][1] === 'list'
      )
      if (chatsListQuery) {
        queryClient.setQueryData(chatsListQuery.queryKey, (old: any[] | undefined) => {
          if (!old) return old
          // Update the timestamp and sort by updatedAt descending
          const updated = old.map((c: any) =>
            c.id === conversationRef.current.parentChatId ? { ...c, updatedAt: now } : c,
          )
          return updated.sort(
            (a: any, b: any) =>
              new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
          )
        })
      }
    }

    // Optimistically update conversation timestamp to move it to top
    useAgentConversationStore.getState().updateConversationTimestamp(conversationRef.current.id)

    // Enable auto-scroll and immediately scroll to bottom
    actionsRef.current.scrollToBottom()

    console.log("[ChatSend] Sending message", {
      conversationId: conversationRef.current.id,
      textLength: text.length,
      partCount: parts.length,
    })

    if (collaborationRef.current.enabled) {
      try {
        const sessionResult = await collaborationRef.current.session.submitInteraction({
          text,
          kind: "message",
          mentionedAgentIds: extractAgentMentions(text),
          metadata: {
            provider: workspaceRef.current.provider,
          },
        })

        if (sessionResult.route === "collaboration") {
          messagingRef.current.setMessages((current: any[]) => [
            ...current,
            {
              id: `collaboration-user-${Date.now()}-${Math.random()
                .toString(36)
                .slice(2, 8)}`,
              role: "user",
              parts,
            },
          ])
          actionsRef.current.scrollToBottom()
          return
        }
      } catch (error) {
        console.warn(
          "[CollaborationSession] Supervisor submission failed; using lightweight chat",
          error,
        )
      }
    }

    messagingRef.current.submitImplicitInteraction(text)
    await messagingRef.current.sendMessageRef.current({ role: "user", parts })
  }, [])

  // Queue handlers for sending queued messages
  const handleSendFromQueue = useCallback(async (itemId: string) => {
    const item = queueRef.current.popItemFromQueue(conversationRef.current.id, itemId)
    if (!item) return

    try {
      // Stop current stream if streaming and wait for status to become ready.
      // The server-side save block preserves sessionId on abort, so the next
      // message can resume the session with full conversation context.
      if (inputRefsRef.current.isStreaming.current) {
        await messagingRef.current.handleStop()
        await waitForStreamingReady(conversationRef.current.id)
      }

      // Build message parts from queued item
      const parts: any[] = [
        ...(item.images || []).map((img: any) => ({
          type: "data-image" as const,
          data: {
            url: img.url,
            mediaType: img.mediaType,
            filename: img.filename,
            base64Data: img.base64Data,
          },
        })),
        ...(item.files || []).map((f: any) => ({
          type: "data-file" as const,
          data: {
            url: f.url,
            mediaType: f.mediaType,
            filename: f.filename,
            size: f.size,
          },
        })),
      ]

      // Add text contexts as mention tokens
      let mentionPrefix = ""
      if (item.textContexts && item.textContexts.length > 0) {
        const quoteMentions = item.textContexts.map((tc: any) => {
          const preview = tc.text.slice(0, 50).replace(/[:\[\]]/g, "") // Create and sanitize preview
          const encodedText = utf8ToBase64(tc.text) // Base64 encode full text
          return `@[${MENTION_PREFIXES.QUOTE}${preview}:${encodedText}]`
        })
        mentionPrefix = quoteMentions.join(" ") + " "
      }

      // Add diff text contexts as mention tokens
      if (item.diffTextContexts && item.diffTextContexts.length > 0) {
        const diffMentions = item.diffTextContexts.map((dtc: any) => {
          const preview = dtc.text.slice(0, 50).replace(/[:\[\]]/g, "") // Create and sanitize preview
          const encodedText = utf8ToBase64(dtc.text) // Base64 encode full text
          const lineNum = dtc.lineNumber || 0
          return `@[${MENTION_PREFIXES.DIFF}${dtc.filePath}:${lineNum}:${preview}:${encodedText}]`
        })
        mentionPrefix += diffMentions.join(" ") + " "
      }

      // Add pasted text / chat history as mentions
      if (item.pastedTexts && item.pastedTexts.length > 0) {
        const pastedMentions = item.pastedTexts.map((pt: any) => {
          const sanitizedPreview = pt.preview.replace(/[:\[\]|]/g, "")
          const prefix = pt.kind === "chatHistory" ? MENTION_PREFIXES.CHAT_HISTORY : MENTION_PREFIXES.PASTED
          return `@[${prefix}${pt.size}:${sanitizedPreview}|${pt.filePath}]`
        })
        mentionPrefix += pastedMentions.join(" ") + " "
      }

      if (item.message || mentionPrefix) {
        parts.push({ type: "text", text: mentionPrefix + (item.message || "") })
      }

      // Track message sent
      messagingRef.current.trackMessageSent({
        workspaceId: conversationRef.current.id,
        messageLength: item.message.length,
        mode: conversationModeRef.current,
      })

      // Update timestamps
      useAgentConversationStore.getState().updateConversationTimestamp(conversationRef.current.id)

      // Enable auto-scroll and immediately scroll to bottom
      actionsRef.current.scrollToBottom()

      await messagingRef.current.sendMessageRef.current({ role: "user", parts })
    } catch (error) {
      console.error("[handleSendFromQueue] Error sending queued message:", error)
      // Requeue the item at the front so it isn't lost
      useMessageQueueStore.getState().prependItem(conversationRef.current.id, item)
    }
  }, [])

  const handleRemoveFromQueue = useCallback((itemId: string) => {
    queueRef.current.removeFromQueue(conversationRef.current.id, itemId)
  }, [])

  // Force send - stop stream and send immediately, bypassing queue (Opt+Enter)
  const handleForceSend = useCallback(async () => {
    // Block sending while sandbox is still being set up
    if (workspaceRef.current.sandboxSetupStatus !== "ready") {
      return
    }

    // Get value from uncontrolled editor
    const inputValue = inputRefsRef.current.editor.current?.getValue() || ""
    const hasText = inputValue.trim().length > 0
    const currentImages = imagesRefLocal.current
    const currentFiles = filesRefLocal.current
    const hasImages =
      currentImages.filter((img) => !img.isLoading && img.url).length > 0

    if (!hasText && !hasImages) return

    // Stop current stream if streaming and wait for status to become ready.
    // The server-side save block sets sessionId=null on abort, so the next
    // message starts fresh without needing an explicit cancel mutation.
    if (inputRefsRef.current.isStreaming.current) {
      await messagingRef.current.handleStop()
      await waitForStreamingReady(conversationRef.current.id)
    }

    // Auto-restore archived workspace when sending a message
    if (conversationRef.current.isArchived && actionsRef.current.onRestoreWorkspace) {
      actionsRef.current.onRestoreWorkspace()
    }

    const text = inputValue.trim()

    // Clear editor and draft from localStorage
    inputRefsRef.current.editor.current?.clear()
    if (conversationRef.current.parentChatId) {
      actionsRef.current.clearConversationDraft(conversationRef.current.parentChatId, conversationRef.current.id)
    }

    // Track message sent
    messagingRef.current.trackMessageSent({
      workspaceId: conversationRef.current.id,
      messageLength: text.length,
      mode: conversationModeRef.current,
    })

    // Build message parts
    const parts: any[] = [
      ...currentImages
        .filter((img) => !img.isLoading && img.url)
        .map((img) => ({
          type: "data-image" as const,
          data: {
            url: img.url,
            mediaType: img.mediaType,
            filename: img.filename,
            base64Data: img.base64Data,
          },
        })),
      ...currentFiles
        .filter((f) => !f.isLoading && f.url)
        .map((f) => ({
          type: "data-file" as const,
          data: {
            url: f.url,
            mediaType: f.type,
            filename: f.filename,
            size: f.size,
          },
        })),
    ]

    if (text) {
      parts.push({ type: "text", text: text })
    }

    // Clear attachments
    actionsRef.current.clearAll()

    // Update timestamps
    useAgentConversationStore.getState().updateConversationTimestamp(conversationRef.current.id)

    // Force scroll to bottom
    actionsRef.current.scrollToBottom()

    try {
      await messagingRef.current.sendMessageRef.current({ role: "user", parts })
    } catch (error) {
      console.error("[handleForceSend] Error sending message:", error)
      // Restore editor content so the user can retry
      inputRefsRef.current.editor.current?.setValue(text)
    }
  }, [])

  return {
    handleSend,
    handleSendFromQueue,
    handleRemoveFromQueue,
    handleForceSend,
  }
}
