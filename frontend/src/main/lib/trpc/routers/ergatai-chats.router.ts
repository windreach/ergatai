import {
  AgentOutputEvent,
  BackendChat,
  BackendCollaborationInteractionResult,
  BackendCollaborationSessionDetail,
  CollaborationContextEvent,
  CollaborationRuntimeEvent,
  agentIdSchema,
  chatIdSchema,
  clientRequestIdSchema,
  conversationKeySchema,
  ergataiFetch,
  getErgataiAuthConfig,
  isErgataiApiError,
  isValidChatId,
  mapChat,
  mapCollaborationInteractionResult,
  mapCollaborationSessionDetail,
  observable,
  projectIdSchema,
  publicProcedure,
  router,
  subscribeRawAgentStream,
  z,
} from "./ergatai-shared"

export const chatsRouter = router({

  // ── Chats Endpoints ─────────────────────────────────────────────────────

  /** List all chats (optionally filtered by workspace) */
  listChats: publicProcedure
    .input(z.object({
      workspaceId: z.string().optional(),
    }).optional())
    .query(async ({ input }) => {
      const params = new URLSearchParams()
      if (input?.workspaceId) params.set('workspace_id', input.workspaceId)
      const query = params.toString() ? `?${params.toString()}` : ""
      const chats = await ergataiFetch<BackendChat[]>(`/api/v1/chats${query}`)
      return chats.map(mapChat)
    }),



  /** Create a new chat */
  createChat: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        name: z.string().optional(),
        collaboration_mode: z.string().optional(),
        worktree_path: z.string().optional(),
        branch: z.string().optional(),
        base_branch: z.string().optional(),
        pr_url: z.string().optional(),
        pr_number: z.number().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const chat = await ergataiFetch<BackendChat>("/api/v1/chats", {
        method: "POST",
        body: JSON.stringify({
          workspace_id: input.workspaceId,
          name: input.name,
          collaboration_mode: input.collaboration_mode,
          worktree_path: input.worktree_path,
          branch: input.branch,
          base_branch: input.base_branch,
          pr_url: input.pr_url,
          pr_number: input.pr_number,
        }),
      })

      const mappedChat = mapChat(chat)
      return {
        ...mappedChat,
        conversations: [],
      }
    }),



  /** Get a chat by ID */
  getChat: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      // A persisted UI selection may survive a dev database reset. Treat a
      // missing chat as "not found" so callers can clear the stale selection.
      let chat: BackendChat | null
      try {
        chat = await ergataiFetch<BackendChat | null>(
          `/api/v1/chats/${input.id}`,
          { silentStatus: [404] },
        )
      } catch (error) {
        if (isErgataiApiError(error) && error.status === 404) return null
        throw error
      }
      return chat ? mapChat(chat) : null
    }),



  /** Update a chat */
  updateChat: publicProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().optional(),
        collaborationMode: z.string().optional(),
        worktreePath: z.string().nullish(),
        branch: z.string().nullish(),
        baseBranch: z.string().nullish(),
        prUrl: z.string().nullish(),
        prNumber: z.number().int().nullish(),
      }),
    )
    .mutation(async ({ input }) => {
      const { id, ...updates } = input
      const payload: Record<string, unknown> = {}
      if (updates.name !== undefined) payload.name = updates.name
      if (updates.collaborationMode !== undefined) payload.collaboration_mode = updates.collaborationMode
      if (updates.worktreePath !== undefined) payload.worktree_path = updates.worktreePath
      if (updates.branch !== undefined) payload.branch = updates.branch
      if (updates.baseBranch !== undefined) payload.base_branch = updates.baseBranch
      if (updates.prUrl !== undefined) payload.pr_url = updates.prUrl
      if (updates.prNumber !== undefined) payload.pr_number = updates.prNumber

      const chat = await ergataiFetch<BackendChat>(`/api/v1/chats/${id}`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      })
      return mapChat(chat)
    }),



  /** Archive a chat */
  archiveChat: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      await ergataiFetch(`/api/v1/chats/${input.id}/archive`, {
        method: "POST",
      })
      return { success: true }
    }),



  /** Restore a chat */
  unarchiveChat: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      await ergataiFetch(`/api/v1/chats/${input.id}/unarchive`, {
        method: "POST",
      })
      return { success: true }
    }),



  /** Delete a chat */
  deleteChat: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      await ergataiFetch(`/api/v1/chats/${input.id}`, {
        method: "DELETE",
      })
      return { success: true }
    }),



  /** Get all agents bound to a chat (for agent-to-agent routing) */
  getChatAgents: publicProcedure
    .input(z.object({ chatId: chatIdSchema }))
    .query(async ({ input }) => {
      if (!isValidChatId(input.chatId, "getChatAgents")) {
        return []
      }

      try {
        const response = await ergataiFetch<{
          agents: Array<{
            agent_id: string
            conversation_id: string
            state: string
            profile: string | null
            last_heartbeat: string
          }>
        }>(`/api/v1/chats/${encodeURIComponent(input.chatId)}/agents`)
        return response.agents
      } catch (err) {
        // Backend endpoint not yet implemented — return empty
        console.warn("[ergatai] getChatAgents failed (backend may not support it yet):", err)
        return []
      }
    }),



  /** Spawn a new agent session (for explicit new session requests) */
  spawnAgentSession: publicProcedure
    .input(
      z.object({
        agentId: agentIdSchema,
        targetCommand: z.string(),
        reason: z.enum(["explicit_request", "context_overflow", "task_separation"]).optional(),
        inheritContext: z.boolean().optional(),
        workspaceId: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      try {
        const result = await ergataiFetch<{
          new_session_id: string
          new_agent_id: string
          message: string
        }>(`/api/v1/agents/${input.agentId}/fork`, {
          method: "POST",
          body: JSON.stringify({
            target_command: input.targetCommand,
            reason: input.reason || "explicit_request",
            inherit_context: input.inheritContext || false,
            workspace_id: input.workspaceId,
          }),
        })
        return result
      } catch (err) {
        console.error("[ergatai] spawnAgentSession failed:", err)
        throw err
      }
    }),



  /** Send a non-blocking prompt and associate it with a conversation */
  promptAgent: publicProcedure
    .input(
      z.object({
        agentId: agentIdSchema,
        message: z.string(),
        conversationId: conversationKeySchema.optional(),
        senderAgentId: z.string().optional(),
        senderAgentName: z.string().optional(),
        images: z
          .array(
            z.object({
              base64Data: z.string(),
              mediaType: z.string(),
              filename: z.string().optional(),
            }),
          )
          .optional(),
        files: z
          .array(
            z.object({
              base64Data: z.string(),
              mediaType: z.string().optional(),
              filename: z.string(),
              size: z.number().optional(),
            }),
          )
          .optional(),
        waitForStream: z.boolean().optional(),
        clientRequestId: clientRequestIdSchema.optional(), // Persisted/backend-allocated message ID
        interrupt: z.boolean().optional(),  // Insert at safe point instead of FIFO queue
      }),
    )
    .mutation(async ({ input }) => {
      return ergataiFetch<{
        status: string
        prompt_id: string
        old_agent_id?: string
        new_agent_id?: string
      }>(
        `/api/v1/agents/${input.agentId}/prompt`,
        {
          method: "POST",
          body: JSON.stringify({
            message: input.message,
            conversation_id: input.conversationId,
            sender_agent_id: input.senderAgentId,
            sender_agent_name: input.senderAgentName,
            images: input.images ?? [],
            files: input.files ?? [],
            wait_for_stream: input.waitForStream ?? true,
            client_request_id: input.clientRequestId,
            interrupt: input.interrupt ?? false,
          }),
        },
      )
    }),



  /** Cancel an active prompt for an agent */
  cancelPrompt: publicProcedure
    .input(z.object({ agentId: agentIdSchema }))
    .mutation(async ({ input }) => {
      await ergataiFetch(`/api/v1/agents/${input.agentId}/cancel`, {
        method: "POST",
      })
      return { success: true }
    }),



  /** Stream agent output through the main process to avoid browser CORS */
  subscribeAgentStream: publicProcedure
    .input(
      z.object({
        agentId: agentIdSchema,
        promptId: z.string().optional(),
        conversationId: conversationKeySchema.optional(),
      }),
    )
    .subscription(({ input }) => {
      return observable<AgentOutputEvent>((emit) => {
        return subscribeRawAgentStream(
          input.agentId,
          input.promptId,
          input.conversationId,
          (event) => {
            emit.next(event)
            if (event.type === "done" || event.type === "error") {
              emit.complete()
            }
          },
          (error) => emit.error(error),
          () => emit.complete(),
        )
      })
    }),



  // ── Implicit Collaboration Runtime Endpoints ────────────────────────────

  /** Find the authoritative collaboration session for a chat */
  findCollaborationSessionByChat: publicProcedure
    .input(z.object({ chatId: chatIdSchema }))
    .query(async ({ input }) => {
      try {
        const sessions = await ergataiFetch<BackendCollaborationSessionDetail[]>(
          `/api/v1/collaboration-sessions?chat_id=${encodeURIComponent(input.chatId)}`,
        )
        return sessions.length > 0 ? mapCollaborationSessionDetail(sessions[0]) : null
      } catch (error) {
        if (isErgataiApiError(error) && error.status === 404) return null
        throw error
      }
    }),



  /** Create or return an authoritative collaboration session */
  createCollaborationSession: publicProcedure
    .input(
      z.object({
        chatId: chatIdSchema,
        workspaceId: z.string().optional(),
        projectId: projectIdSchema.optional(),
        mode: z.enum(["supervisor", "group"]),
        goal: z.string().optional(),
        participants: z
          .array(
            z.object({
              conversationId: conversationKeySchema,
              agentId: agentIdSchema,
              role: z.string().optional(),
              status: z.string().optional(),
            }),
          )
          .optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const session = await ergataiFetch<BackendCollaborationSessionDetail>(
        "/api/v1/collaboration-sessions",
        {
          method: "POST",
          body: JSON.stringify({
            chat_id: input.chatId,
            workspace_id: input.workspaceId,
            project_id: input.projectId,
            mode: input.mode,
            goal: input.goal,
            participants: input.participants?.map((participant) => ({
              conversation_id: participant.conversationId,
              agent_id: participant.agentId,
              role: participant.role,
              status: participant.status,
            })),
          }),
        },
      )
      return mapCollaborationSessionDetail(session)
    }),



  /** Submit an interaction to a collaboration session */
  submitCollaborationSessionInteraction: publicProcedure
    .input(
      z.object({
        sessionId: z.string(),
        text: z.string(),
        kind: z.enum(["goal", "message", "input", "artifact"]).optional(),
        mentionedAgentIds: z.array(z.string()).optional(),
        selectedAgentIds: z.array(z.string()).optional(),
        constraints: z.array(z.string()).optional(),
        artifactRefs: z.array(z.string()).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
        route: z.enum(["auto", "lightweight", "collaboration"]).optional(),
        autoExecute: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const result = await ergataiFetch<BackendCollaborationInteractionResult>(
        `/api/v1/collaboration-sessions/${encodeURIComponent(input.sessionId)}/interactions`,
        {
          method: "POST",
          body: JSON.stringify({
            text: input.text,
            kind: input.kind ?? "message",
            mentioned_agent_ids: input.mentionedAgentIds ?? [],
            selected_agent_ids: input.selectedAgentIds ?? [],
            constraints: input.constraints ?? [],
            artifact_refs: input.artifactRefs ?? [],
            metadata: input.metadata ?? {},
            route: input.route ?? "auto",
            auto_execute: input.autoExecute ?? true,
          }),
        },
      )
      return mapCollaborationInteractionResult(result)
    }),



  /** List resumable collaboration session context events */
  listCollaborationSessionEvents: publicProcedure
    .input(
      z.object({
        sessionId: z.string(),
        after: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(500).optional(),
      }),
    )
    .query(async ({ input }) => {
      const query = new URLSearchParams()
      if (input.after !== undefined) query.set("after", String(input.after))
      if (input.limit !== undefined) query.set("limit", String(input.limit))
      const suffix = query.size > 0 ? `?${query.toString()}` : ""
      return ergataiFetch<CollaborationContextEvent[]>(
        `/api/v1/collaboration-sessions/${encodeURIComponent(input.sessionId)}/events${suffix}`,
      )
    }),



  /** Submit a user interaction to a collaboration session */
  submitCollaborationInteraction: publicProcedure
    .input(
      z.object({
        sessionId: z.string(),
        interaction: z.object({
          type: z.literal("message_submitted"),
          chatId: chatIdSchema,
          text: z.string(),
          mentions: z.array(z.string()).optional(),
          workspaceId: z.string().optional(),
        }),
        collaborationMode: z.enum(["supervisor", "group"]),
      }),
    )
    .mutation(async ({ input }) => {
      return ergataiFetch<Record<string, unknown>>(
        `/api/v1/collaboration-sessions/${encodeURIComponent(input.sessionId)}/interactions`,
        {
          method: "POST",
          body: JSON.stringify({
            interaction: input.interaction,
            collaboration_mode: input.collaborationMode,
          }),
        },
      )
    }),



  /** Subscribe to collaboration session events via SSE */
  subscribeCollaborationRuntime: publicProcedure
    .input(z.object({ sessionId: z.string() }))
    .subscription(({ input }) => {
      return observable<CollaborationRuntimeEvent>((emit) => {
        const abortController = new AbortController()
        let cleanedUp = false

        const cleanup = () => {
          if (cleanedUp) return
          cleanedUp = true
          abortController.abort()
        }

        const parseEvent = (rawEvent: string): CollaborationRuntimeEvent | null => {
          const data = rawEvent
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => {
              const value = line.slice(5)
              return value.startsWith(" ") ? value.slice(1) : value
            })
            .join("\n")

          if (!data) return null
          const parsed = JSON.parse(data)
          return parsed && typeof parsed === "object"
            ? (parsed as CollaborationRuntimeEvent)
            : null
        }

        void (async () => {
          try {
            const { apiUrl, token } = getErgataiAuthConfig()
            const response = await fetch(
              `${apiUrl}/api/v1/collaboration-sessions/${encodeURIComponent(input.sessionId)}/stream`,
              {
                headers: {
                  Accept: "text/event-stream",
                  Authorization: `Bearer ${token}`,
                },
                signal: abortController.signal,
              },
            )

            if (!response.ok) {
              const detail = await response.text().catch(() => "unknown error")
              throw new Error(
                `Collaboration session stream failed (${response.status}): ${detail}`,
              )
            }
            if (!response.body) {
              throw new Error("Collaboration session stream has no readable body")
            }

            const reader = response.body.getReader()
            const decoder = new TextDecoder()
            let buffer = ""

            while (true) {
              const { done, value } = await reader.read()
              if (done) break

              buffer += decoder.decode(value, { stream: true })
              buffer = buffer.replaceAll("\r\n", "\n").replaceAll("\r", "\n")

              while (true) {
                const boundary = buffer.indexOf("\n\n")
                if (boundary === -1) break

                const rawEvent = buffer.slice(0, boundary)
                buffer = buffer.slice(boundary + 2)
                const event = parseEvent(rawEvent)
                if (event) emit.next(event)
              }
            }

            emit.complete()
          } catch (error) {
            if (!abortController.signal.aborted) {
              emit.error(
                error instanceof Error
                  ? error
                  : new Error("Collaboration session stream failed"),
              )
            }
          }
        })()

      return cleanup
    })
  }),



  /** Get chat agent graph */
  getChatAgentGraph: publicProcedure
    .input(z.object({ chatId: chatIdSchema }))
    .query(async ({ input }) => {
      if (!isValidChatId(input.chatId, "getChatAgentGraph")) {
        return null
      }

      return ergataiFetch(`/api/v1/chats/${encodeURIComponent(input.chatId)}/agent-graph`)
    }),



  /** Get chat agents (alias for existing getChatAgents) */
  getChatAgentsList: publicProcedure
    .input(z.object({ chatId: chatIdSchema }))
    .query(async ({ input }) => {
      if (!isValidChatId(input.chatId, "getChatAgentsList")) {
        return { agents: [] }
      }

      return ergataiFetch(`/api/v1/chats/${encodeURIComponent(input.chatId)}/agents`)
    }),



  // ── Collaboration Sessions (11 endpoints) ───────────────────────────────

  /** Get collaboration session by chat */
  getCollaborationSessionByChat: publicProcedure
    .input(z.object({ chatId: chatIdSchema }))
    .query(async ({ input }) => {
      const sessions = await ergataiFetch<BackendCollaborationSessionDetail[]>(
        `/api/v1/collaboration-sessions?chat_id=${encodeURIComponent(input.chatId)}`,
      )
      return sessions.length > 0 ? mapCollaborationSessionDetail(sessions[0]) : null
    }),



  /** Get collaboration session status */
  getCollaborationSessionStatus: publicProcedure
    .input(z.object({ sessionId: z.string() }))
    .query(async ({ input }) => {
      return ergataiFetch(`/api/v1/collaboration-sessions/${encodeURIComponent(input.sessionId)}/status`)
    }),



  /** Get collaboration session progress */
  getCollaborationSessionProgress: publicProcedure
    .input(z.object({ sessionId: z.string() }))
    .query(async ({ input }) => {
      return ergataiFetch(`/api/v1/collaboration-sessions/${encodeURIComponent(input.sessionId)}/progress`)
    }),



  /** Create collaboration session approval */
  createCollaborationApproval: publicProcedure
    .input(z.object({
      sessionId: z.string(),
      approval: z.unknown(),
    }))
    .mutation(async ({ input }) => {
      return ergataiFetch(`/api/v1/collaboration-sessions/${encodeURIComponent(input.sessionId)}/approvals`, {
        method: "POST",
        body: JSON.stringify(input.approval),
      })
    }),



  /** Cancel collaboration session */
  cancelCollaborationSession: publicProcedure
    .input(z.object({ sessionId: z.string() }))
    .mutation(async ({ input }) => {
      return ergataiFetch(`/api/v1/collaboration-sessions/${encodeURIComponent(input.sessionId)}/cancel`, {
        method: "POST",
      })
    }),



  /** Update collaboration session state */
  updateCollaborationSessionState: publicProcedure
    .input(z.object({
      sessionId: z.string(),
      state: z.unknown(),
    }))
    .mutation(async ({ input }) => {
      return ergataiFetch(`/api/v1/collaboration-sessions/${encodeURIComponent(input.sessionId)}/state`, {
        method: "POST",
        body: JSON.stringify(input.state),
      })
    }),



  /** Decide on collaboration approval */
  decideCollaborationApproval: publicProcedure
    .input(z.object({
      sessionId: z.string(),
      approvalId: z.string(),
      decision: z.unknown(),
    }))
    .mutation(async ({ input }) => {
      return ergataiFetch(`/api/v1/collaboration-sessions/${encodeURIComponent(input.sessionId)}/approvals/${input.approvalId}/decision`, {
        method: "POST",
        body: JSON.stringify(input.decision),
      })
    }),



  /** List collaboration session conversations */
  listCollaborationSessionConversations: publicProcedure
    .input(z.object({
      sessionId: z.string(),
    }))
    .query(async ({ input }) => {
      return ergataiFetch(`/api/v1/collaboration-sessions/${encodeURIComponent(input.sessionId)}/conversations`)
    }),



  /** Get collaboration session conversation */
  getCollaborationSessionConversation: publicProcedure
    .input(z.object({
      sessionId: z.string(),
      conversationId: conversationKeySchema,
    }))
    .query(async ({ input }) => {
      return ergataiFetch(`/api/v1/collaboration-sessions/${encodeURIComponent(input.sessionId)}/conversations/${encodeURIComponent(input.conversationId)}`)
    }),



  /** List collaboration session plans */
  listCollaborationSessionPlans: publicProcedure
    .input(z.object({
      sessionId: z.string(),
    }))
    .query(async ({ input }) => {
      return ergataiFetch(`/api/v1/collaboration-sessions/${encodeURIComponent(input.sessionId)}/plans`)
    }),



  /** Get collaboration session plan */
  getCollaborationSessionPlan: publicProcedure
    .input(z.object({
      sessionId: z.string(),
      planId: z.string(),
    }))
    .query(async ({ input }) => {
      return ergataiFetch(`/api/v1/collaboration-sessions/${encodeURIComponent(input.sessionId)}/plans/${encodeURIComponent(input.planId)}`)
    }),



  /** Execute collaboration session plan */
  executeCollaborationSessionPlan: publicProcedure
    .input(z.object({
      sessionId: z.string(),
      planId: z.string(),
    }))
    .mutation(async ({ input }) => {
      return ergataiFetch(`/api/v1/collaboration-sessions/${encodeURIComponent(input.sessionId)}/plans/${encodeURIComponent(input.planId)}/execute`, {
        method: "POST",
      })
    }),



  /** Get collaboration session events */
  getCollaborationSessionEvents: publicProcedure
    .input(z.object({
      sessionId: z.string(),
    }))
    .query(async ({ input }) => {
      return ergataiFetch(`/api/v1/collaboration-sessions/${encodeURIComponent(input.sessionId)}/events`)
    }),



  /** Subscribe to collaboration session stream */
  subscribeCollaborationSessionStream: publicProcedure
    .input(z.object({ sessionId: z.string() }))
    .subscription(({ input }) => {
      return observable<unknown>((emit) => {
        const abortController = new AbortController()
        let cleanedUp = false

        const cleanup = () => {
          if (cleanedUp) return
          cleanedUp = true
          abortController.abort()
        }

        const parseEvent = (rawEvent: string): unknown | null => {
          const data = rawEvent
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => {
              const value = line.slice(5)
              return value.startsWith(" ") ? value.slice(1) : value
            })
            .join("\n")

          if (!data) return null
          const parsed = JSON.parse(data)
          return parsed && typeof parsed === "object" ? parsed : null
        }

        void (async () => {
          try {
            const { apiUrl, token } = getErgataiAuthConfig()
            const response = await fetch(
              `${apiUrl}/api/v1/collaboration-sessions/${encodeURIComponent(input.sessionId)}/stream`,
              {
                headers: {
                  Accept: "text/event-stream",
                  Authorization: `Bearer ${token}`,
                },
                signal: abortController.signal,
              },
            )

            if (!response.ok) {
              const detail = await response.text().catch(() => "unknown error")
              throw new Error(`Session stream failed (${response.status}): ${detail}`)
            }
            if (!response.body) {
              throw new Error("Session stream has no readable body")
            }

            const reader = response.body.getReader()
            const decoder = new TextDecoder()
            let buffer = ""

            while (true) {
              const { done, value } = await reader.read()
              if (done) break

              buffer += decoder.decode(value, { stream: true })
              buffer = buffer.replaceAll("\r\n", "\n").replaceAll("\r", "\n")

              while (true) {
                const boundary = buffer.indexOf("\n\n")
                if (boundary === -1) break

                const rawEvent = buffer.slice(0, boundary)
                buffer = buffer.slice(boundary + 2)
                const event = parseEvent(rawEvent)
                if (event) emit.next(event)
              }
            }

            emit.complete()
          } catch (error) {
            if (!abortController.signal.aborted) {
              emit.error(error instanceof Error ? error : new Error("Session stream failed"))
            }
          }
        })()

        return cleanup
      })
    }),


})
