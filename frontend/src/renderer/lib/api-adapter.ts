/**
 * API adapter for desktop app
 * Bridges the component-facing API shape to real tRPC calls over IPC.
 */

import { useMemo } from "react"
import { normalizeCodexToolPart } from "../../shared/codex-tool-normalizer"
import { trpc } from "./trpc"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObj = Record<string, any>

// Module-level utils reference, set when useUtils() is called
let _utils: ReturnType<typeof trpc.useUtils> | null = null

/** Invalidate all chat/conversation lists after mutations */
function invalidateChatLists() {
  if (!_utils) return
  _utils.chats.list.invalidate()
  _utils.chats.listArchived.invalidate()
  _utils.ergatai.listWorkspaceConversations.invalidate()
  void _utils.ergatai.workspaceStatus.invalidate()
}

export const api = {
  agents: {
    getAgentChats: {
      useQuery: (_args?: AnyObj, opts?: AnyObj) => {
        // Use real tRPC
        const result = trpc.chats.list.useQuery({}, {
          enabled: opts?.enabled !== false,
        })
        return {
          data: result.data ?? [],
          isLoading: result.isLoading,
        }
      },
    },
    getAgentChat: {
      useQuery: (args?: { chatId: string }, opts?: AnyObj) => {
        const chatId = args?.chatId
        // chats.get expects a chat/container ID, not a conversation ID.
        const isValidChatId = !!chatId?.startsWith("chat_")
        const result = trpc.chats.get.useQuery(
          { id: chatId ?? "" },
          {
            ...(opts ?? {}),
            enabled: !!isValidChatId && opts?.enabled !== false,
            staleTime: opts?.staleTime ?? 0,
            gcTime: opts?.gcTime ?? 30_000,
          },
        )

        // Memoize transformation to prevent infinite re-renders
        const transformedData = useMemo(() => {
          if (result.data === undefined) return undefined
          if (result.data === null) return null
          return {
            ...result.data,
            // Desktop uses worktrees, not sandboxes
            sandbox_id: null,
            meta: null,
            // Map conversations to expected format
            conversations: result.data.conversations?.map((sc: AnyObj) => {
              let parsedMessages = []
              try {
                // Handle both JSON string and array formats
                if (Array.isArray(sc.messages)) {
                  parsedMessages = sc.messages
                } else if (sc.messages) {
                  parsedMessages = typeof sc.messages === "string"
                    ? JSON.parse(sc.messages)
                    : []
                }
                // Transform old tool-invocation parts to new tool-{toolName} format
                parsedMessages = parsedMessages.map((msg: AnyObj) => {
                  if (!msg.parts) return msg
                  // Backend returns parts as JSON string, parse it if needed
                  let partsArray = msg.parts
                  if (typeof partsArray === "string") {
                    try {
                      partsArray = JSON.parse(partsArray)
                    } catch {
                      return msg
                    }
                  }
                  if (!Array.isArray(partsArray)) return msg
                  return {
                    ...msg,
                    parts: partsArray.map((part: AnyObj) => {
                      // Migrate old "tool-invocation" type to "tool-{toolName}"
                      if (part.type === "tool-invocation" && part.toolName) {
                        return {
                          ...part,
                          type: `tool-${part.toolName}`,
                          toolCallId: part.toolCallId || part.toolInvocationId,
                          input: part.input || part.args,
                        }
                      }
                      // Normalize Codex MCP wrapper shape (e.g. tool-Tool: notion/notion-search)
                      // to canonical tool-mcp__{server}__{tool} so MCP renderer can parse it.
                      if (
                        part.type?.startsWith("tool-Tool:") ||
                        part.toolName?.startsWith("Tool:") ||
                        part.input?.toolName?.startsWith("Tool:")
                      ) {
                        const normalizedMcpPart = normalizeCodexToolPart(part) as AnyObj
                        if (normalizedMcpPart !== part) {
                          if (normalizedMcpPart.state) {
                            let normalizedState = normalizedMcpPart.state
                            if (normalizedMcpPart.state === "result") {
                              normalizedState =
                                normalizedMcpPart.result?.success === false
                                  ? "output-error"
                                  : "output-available"
                            }
                            return {
                              ...normalizedMcpPart,
                              state: normalizedState,
                              output:
                                normalizedMcpPart.output ||
                                normalizedMcpPart.result,
                            }
                          }
                          return normalizedMcpPart
                        }
                      }
                      // Normalize ACP/codex tool types (e.g. "tool-Read README.md" → "tool-Read")
                      // Detects ACP parts by: title-based type with space, or proxy tool name, or input.toolName present
                      if (part.type?.startsWith("tool-") && (part.input?.toolName || part.type.includes(" ") || part.type === "tool-acp.acp_provider_agent_dynamic_tool")) {
                        const acpVerbMap: AnyObj = {
                          Read: "Read", Run: "Bash", List: "Glob", Search: "Grep",
                          Grep: "Grep", Glob: "Glob", Edit: "Edit", Write: "Write",
                          Thought: "Thinking", Fetch: "WebFetch",
                        }
                        let parsedInput: AnyObj = {}
                        if (part.input && typeof part.input === "object") {
                          parsedInput = part.input as AnyObj
                        } else if (typeof part.input === "string") {
                          try {
                            const parsed = JSON.parse(part.input)
                            if (parsed && typeof parsed === "object") {
                              parsedInput = parsed as AnyObj
                            }
                          } catch {
                            parsedInput = {}
                          }
                        }
                        const title: string = parsedInput.toolName || part.type.slice(5)
                        const args: AnyObj =
                          parsedInput.args && typeof parsedInput.args === "object"
                            ? parsedInput.args
                            : parsedInput
                        const spaceIdx = title.indexOf(" ")
                        const verb = spaceIdx === -1 ? title : title.slice(0, spaceIdx)
                        const detail = spaceIdx === -1 ? "" : title.slice(spaceIdx + 1)
                        const toolType = acpVerbMap[verb]
                        if (toolType) {
                          const unwrapped: AnyObj = {
                            ...part,
                            type: `tool-${toolType}`,
                            input: { ...args, _acpTitle: title, _acpDetail: detail },
                          }
                          if (toolType === "Read" && !unwrapped.input.file_path && detail) unwrapped.input.file_path = detail
                          if (toolType === "Bash") {
                            if (Array.isArray(unwrapped.input.command)) {
                              unwrapped.input.command = unwrapped.input.command[unwrapped.input.command.length - 1] || detail
                            } else if (!unwrapped.input.command && detail) {
                              unwrapped.input.command = detail
                            }
                          }
                          if (toolType === "Grep" && !unwrapped.input.pattern && detail) unwrapped.input.pattern = detail
                          if (toolType === "Glob" && !unwrapped.input.pattern && detail) unwrapped.input.pattern = detail
                          // State normalization
                          if (unwrapped.state) {
                            let normalizedState = unwrapped.state
                            if (unwrapped.state === "result") {
                              normalizedState = unwrapped.result?.success === false ? "output-error" : "output-available"
                            }
                            return { ...unwrapped, state: normalizedState, output: unwrapped.output || unwrapped.result }
                          }
                          return unwrapped
                        }
                      }
                      // Normalize state field from DB format to AI SDK format
                      // DB stores: "result", "call" -> AI SDK expects: "output-available", "call"
                      if (part.type?.startsWith("tool-") && part.state) {
                        let normalizedState = part.state
                        if (part.state === "result") {
                          // Check if it was an error result
                          normalizedState =
                            part.result?.success === false
                              ? "output-error"
                              : "output-available"
                        }
                        // Also add output field from result if present (for diff display)
                        return {
                          ...part,
                          state: normalizedState,
                          output: part.output || part.result,
                        }
                      }
                      return part
                    }),
                  }
                }).map((msg: AnyObj) => {
                  // Also parse metadata if it's a JSON string
                  if (msg.metadata && typeof msg.metadata === "string") {
                    try {
                      return { ...msg, metadata: JSON.parse(msg.metadata) }
                    } catch {
                      return msg
                    }
                  }
                  return msg
                })
              } catch (e) {
                console.warn(
                  "[api-adapter] Failed to parse messages for conversation:",
                  sc.id,
                  "messages value:", sc.messages,
                  "error:", e,
                )
                parsedMessages = []
              }
              return {
                ...sc,
                created_at: sc.createdAt,
                updated_at: sc.updatedAt,
                messages: parsedMessages,
              }
            }),
          }
        }, [result.data])

        return {
          data: transformedData,
          isLoading: result.isLoading,
        }
      },
    },
    getArchivedChats: {
      useQuery: (_args?: AnyObj, _opts?: AnyObj) => {
        const result = trpc.chats.listArchived.useQuery({})
        return {
          data: result.data ?? [],
          isLoading: result.isLoading,
        }
      },
    },
    archiveChat: {
      useMutation: (opts?: {
        onMutate?: AnyFn
        onError?: AnyFn
        onSettled?: AnyFn
      }) => {
        const mutation = trpc.ergatai.archiveChat.useMutation({
          onSuccess: () => {
            invalidateChatLists()
            opts?.onSettled?.()
          },
          onError: (err) => opts?.onError?.(err),
        })
        return {
          mutate: async (args?: { id: string }) => {
            const context = await opts?.onMutate?.(args)
            if (!args?.id) throw new Error("id is required")
            await mutation.mutateAsync({ id: args.id })
            return context
          },
          isPending: mutation.isPending,
        }
      },
    },
    restoreChat: {
      useMutation: (opts?: {
        onMutate?: AnyFn
        onError?: AnyFn
        onSettled?: AnyFn
      }) => {
        const mutation = trpc.ergatai.unarchiveChat.useMutation({
          onSuccess: () => {
            invalidateChatLists()
            opts?.onSettled?.()
          },
          onError: (err) => opts?.onError?.(err),
        })
        return {
          mutate: async (args?: { id: string }) => {
            const context = await opts?.onMutate?.(args)
            if (!args?.id) throw new Error("id is required")
            await mutation.mutateAsync({ id: args.id })
            return context
          },
          isPending: mutation.isPending,
        }
      },
    },
    renameChat: {
      useMutation: (opts?: { onSuccess?: AnyFn; onError?: AnyFn }) => {
        const mutation = trpc.ergatai.updateChat.useMutation({
          onSuccess: (data) => {
            invalidateChatLists()
            opts?.onSuccess?.(data)
          },
          onError: (err) => opts?.onError?.(err),
        })
        return {
          mutate: (args?: { id: string; name: string }) => {
            if (!args?.id || !args.name) throw new Error("id and name are required")
            mutation.mutate({ id: args.id, name: args.name })
          },
          mutateAsync: async (args?: { id: string; name: string }) => {
            if (!args?.id || !args.name) throw new Error("id and name are required")
            return mutation.mutateAsync({ id: args.id, name: args.name })
          },
        }
      },
    },
    renameConversation: {
      useMutation: (opts?: {
        onSuccess?: AnyFn
        onError?: AnyFn
        onMutate?: AnyFn
      }) => {
        const mutation = trpc.ergatai.updateConversation.useMutation({
          onSuccess: (data) => {
            invalidateChatLists()
            opts?.onSuccess?.(data)
          },
          onError: (err) => opts?.onError?.(err),
        })
        return {
          mutate: (
            args?: { conversationId: string; title: string },
            callbacks?: { onSuccess?: AnyFn },
          ) => {
            if (!args?.conversationId || !args.title) throw new Error("conversationId and title are required")
            mutation.mutate(
              { conversationId: args.conversationId, title: args.title },
              { onSuccess: callbacks?.onSuccess },
            )
          },
          mutateAsync: async (args?: { conversationId: string; title: string }) => {
            if (!args?.conversationId || !args.title) throw new Error("conversationId and title are required")
            return mutation.mutateAsync({
              conversationId: args.conversationId,
              title: args.title,
            })
          },
          isPending: mutation.isPending,
        }
      },
    },
    updateConversationMode: {
      useMutation: (opts?: { onSuccess?: AnyFn; onError?: AnyFn }) => {
        const mutation = trpc.ergatai.updateConversation.useMutation({
          onSuccess: (data) => opts?.onSuccess?.(data),
          onError: (err) => opts?.onError?.(err),
        })
        return {
          mutate: (args?: { conversationId: string; mode: "plan" | "agent" }) => {
            if (!args?.conversationId || !args.mode) throw new Error("conversationId and mode are required")
            mutation.mutate({ conversationId: args.conversationId, mode: args.mode })
          },
          isPending: mutation.isPending,
        }
      },
    },
    // Desktop stubs - not needed for local development
    createAgentPr: {
      useMutation: (opts?: { onSuccess?: AnyFn; onError?: AnyFn }) => ({
        mutate: (_args?: AnyObj, callbacks?: { onSuccess?: AnyFn }) => {
          // Desktop: PR creation not implemented yet
          opts?.onError?.(new Error("PR creation not available in desktop app"))
        },
        mutateAsync: async (_args?: AnyObj) => {
          throw new Error("PR creation not available in desktop app")
        },
        isPending: false,
      }),
    },
    archiveChatsBatch: {
      useMutation: (opts?: { onSuccess?: AnyFn }) => {
        const mutation = trpc.chats.archiveBatch.useMutation({
          onSuccess: () => opts?.onSuccess?.(),
        })
        return {
          mutate: (
            args?: { chatIds: string[] },
            callbacks?: { onSuccess?: AnyFn },
          ) => {
            if (args?.chatIds) {
              mutation.mutate(
                { chatIds: args.chatIds },
                { onSuccess: callbacks?.onSuccess },
              )
            }
          },
          isPending: mutation.isPending,
        }
      },
    },
  },
  usage: {
    getUserUsage: {
      useQuery: (_args?: AnyObj, _opts?: AnyObj) => ({
        // Desktop: no usage limits
        data: {
          usage: 0,
          limit: Infinity,
          planType: "desktop" as const,
          next_payment_at: null,
        },
        isLoading: false,
      }),
    },
  },
  useUtils: () => {
    const utils = trpc.useUtils()
    // Set module-level reference so static mutations can invalidate lists
    _utils = utils
    return {
      agents: {
        getAgentChats: {
          cancel: async () => utils.chats.list.cancel(),
          getData: () => utils.chats.list.getData({}),
          setData: (keyOrUpdater?: unknown, updater?: unknown) => {
            // Handle both signatures
            if (typeof keyOrUpdater === "function") {
              utils.chats.list.setData({}, keyOrUpdater as AnyFn)
            } else if (updater) {
              utils.chats.list.setData({}, updater as AnyFn)
            }
          },
          invalidate: async () => utils.chats.list.invalidate(),
        },
        getArchivedChats: {
          cancel: async () => utils.chats.listArchived.cancel(),
          getData: () => utils.chats.listArchived.getData({}),
          setData: (keyOrUpdater?: unknown, updater?: unknown) => {
            if (typeof keyOrUpdater === "function") {
              utils.chats.listArchived.setData({}, keyOrUpdater as AnyFn)
            } else if (updater) {
              utils.chats.listArchived.setData({}, updater as AnyFn)
            }
          },
          invalidate: async () => utils.chats.listArchived.invalidate(),
        },
        getAgentChat: {
          cancel: async () => {},
          getData: (args?: { chatId: string }) => {
            if (!args?.chatId) return null
            return utils.chats.get.getData({ id: args.chatId })
          },
          setData: (args?: { chatId: string }, updater?: AnyFn) => {
            if (args?.chatId && updater) {
              utils.chats.get.setData({ id: args.chatId }, updater)
            }
          },
          invalidate: async (args?: { chatId: string }) => {
            if (args?.chatId) {
              await utils.chats.get.invalidate({ id: args.chatId })
            }
          },
        },
        getConversations: {
          invalidate: async () => {},
          setData: () => {},
        },
      },
      github: {
        getSlashCommandContent: {
          fetch: async (_args?: AnyObj) => ({ content: "" }),
        },
        searchFiles: {
          cancel: async () => utils.files.search.cancel(),
        },
      },
      user: {
        getProfile: {
          invalidate: async () => {},
        },
      },
      stripe: {
        getCheckoutSession: {
          invalidate: async () => {},
        },
        getUserBalance: {
          invalidate: async () => {},
        },
      },
    }
  },
  // Stubs for features not needed in desktop
  teams: {
    getUserTeams: { useQuery: () => ({ data: [], isLoading: false }) },
    getTeam: { useQuery: () => ({ data: null, isLoading: false }) },
    updateTeam: {
      useMutation: () => ({
        mutate: () => {},
        mutateAsync: async () => ({}),
        isPending: false,
      }),
    },
  },
  repositorySandboxes: {
    getRepositoriesWithStatus: {
      useQuery: () => ({
        data: { repositories: [] },
        isLoading: false,
        refetch: async () => ({ data: { repositories: [] } }),
      }),
    },
  },
  stripe: {
    getUserBalance: { useQuery: () => ({ data: 0, isLoading: false }) },
    createCheckoutSession: {
      useMutation: () => ({
        mutate: () => {},
        mutateAsync: async () => ({ url: "" }),
        isPending: false,
      }),
    },
    createBillingPortalSession: {
      useMutation: () => ({
        mutate: () => {},
        mutateAsync: async () => ({ url: "" }),
        isPending: false,
      }),
    },
  },
  user: {
    getProfile: { useQuery: () => ({ data: null, isLoading: false }) },
    updateProfile: {
      useMutation: () => ({
        mutate: () => {},
        mutateAsync: async () => ({}),
        isPending: false,
      }),
    },
  },
  github: {
    getBranches: {
      useQuery: () => ({
        data: { branches: [] },
        isLoading: false,
        refetch: async () => ({ data: { branches: [] } }),
      }),
    },
    searchFiles: {
      useQuery: (
        args?: {
          teamId?: string
          repository?: string
          query?: string
          limit?: number
          sandboxId?: string
          branch?: string
          projectPath?: string
        },
        opts?: AnyObj,
      ) => {
        // Use real tRPC to search local files
        const result = trpc.files.search.useQuery(
          {
            projectPath: args?.projectPath || "",
            query: args?.query || "",
            limit: args?.limit || 50,
          },
          {
            enabled: !!args?.projectPath && opts?.enabled !== false,
            staleTime: opts?.staleTime ?? 5000,
            refetchOnWindowFocus: opts?.refetchOnWindowFocus ?? false,
            placeholderData: opts?.placeholderData,
          },
        )
        return {
          data: result.data ?? [],
          isLoading: result.isLoading,
          isFetching: result.isFetching,
          error: result.error,
        }
      },
    },
    getSlashCommands: { useQuery: () => ({ data: [], isLoading: false }) },
    getUserInstallations: { useQuery: () => ({ data: [], isLoading: false }) },
    getGithubConnection: {
      useQuery: () => ({ data: { isConnected: false }, isLoading: false }),
    },
    connectGithub: {
      useMutation: () => ({
        mutate: () => {},
        mutateAsync: async () => ({}),
        isPending: false,
      }),
    },
    disconnectGithub: {
      useMutation: () => ({
        mutate: () => {},
        mutateAsync: async () => ({}),
        isPending: false,
      }),
    },
    createBranch: {
      useMutation: () => ({
        mutate: () => {},
        mutateAsync: async () => ({ branch: "" }),
        isPending: false,
      }),
    },
  },
  claudeCode: {
    getClaudeCodeConnection: {
      useQuery: () => ({ data: { isConnected: true }, isLoading: false }),
    },
    connectClaudeCode: {
      useMutation: () => ({
        mutate: () => {},
        mutateAsync: async () => ({}),
        isPending: false,
      }),
    },
    disconnectClaudeCode: {
      useMutation: () => ({
        mutate: () => {},
        mutateAsync: async () => ({}),
        isPending: false,
      }),
    },
  },
  agentInvites: {
    getOrCreateInviteCode: {
      useQuery: () => ({
        data: { maxUses: 0, usesCount: 0 },
        isLoading: false,
      }),
    },
  },
}
