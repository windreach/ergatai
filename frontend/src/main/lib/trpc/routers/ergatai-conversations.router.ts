import {
  AgentBinding,
  AgentInfoSchema,
  AgentOutputEvent,
  AgentPlan,
  AgentPlanSchema,
  AgentProfileSchema,
  AgentProfileWithStatusSchema,
  ApprovalPayload,
  BackendActivityEntry,
  BackendActivityEvent,
  BackendAgentBinding,
  BackendChat,
  BackendCollaborationInteractionResult,
  BackendCollaborationSessionDetail,
  BackendConversation,
  BackendConversationFileChange,
  BackendManagedWorkspace,
  BackendMessage,
  BackendProject,
  BackendWorkspace,
  BackendWorkspaceProject,
  BackendWorkspaceStatus,
  Chat,
  CollaborationContextEvent,
  CollaborationEventPayload,
  CollaborationInteractionResult,
  CollaborationRuntimeEvent,
  CollaborationSession,
  CollaborationSessionDetail,
  CollaborationSessionParticipant,
  CollaborationSessionRuntimeMode,
  CollaborationSessionState,
  Conversation,
  ConversationRuntimeStreamEvent,
  ConversationSummarySchema,
  DagEventPayload,
  DagSubmitResponse,
  DagValidateResponse,
  ErgataiApiError,
  ErgataiConversation,
  ErgataiMessage,
  ErgataiProject,
  ErgataiWorkspace,
  ErgataiWorkspaceProject,
  ErgataiWorkspaceStatus,
  LockAuditEntry,
  LockContention,
  LockInfo,
  Message,
  MessageTypeStats,
  PlanRevisionPayload,
  Project,
  SessionStatePayload,
  SystemConfig,
  TaskEventPayload,
  Workspace,
  WorkspaceProject,
  WorkspaceStatus,
  agentIdSchema,
  chatIdSchema,
  clientRequestIdSchema,
  conversationKeySchema,
  ergataiFetch,
  getErgataiAuthConfig,
  getModelSnapshotManager,
  isErgataiApiError,
  isValidChatId,
  join,
  loadSnapshots,
  mapAgentBinding,
  mapChat,
  mapCollaborationInteractionResult,
  mapCollaborationSessionDetail,
  mapConversation,
  mapManagedWorkspace,
  mapMessage,
  mapProject,
  mapWorkspace,
  mapWorkspaceProject,
  mapWorkspaceProjectToProject,
  mapWorkspaceStatus,
  messageIdSchema,
  mkdir,
  observable,
  parseMessageMetadata,
  parseMessageParts,
  projectIdSchema,
  publicProcedure,
  router,
  subscribeConversationMessages,
  subscribeConversationRuntime,
  subscribeRawAgentStream,
  terminalManager,
  tmpdir,
  z,
} from "./ergatai-shared"

export const conversationsRouter = router({

  /** List root conversations in a workspace */
  listWorkspaceConversations: publicProcedure
    .input(z.object({ workspaceId: z.string() }))
    .query(async ({ input }) => {
      const conversations = await ergataiFetch<BackendConversation[]>(
        `/api/v1/conversations?workspace_id=${encodeURIComponent(input.workspaceId)}`,
      )
      return conversations.map(mapConversation)
    }),



  /** Create a root conversation for a chat */
  createConversation: publicProcedure
    .input(
      z.object({
        chatId: chatIdSchema,
        collaborationSessionId: z.string().optional(),
        title: z.string().optional(),
        mode: z.string().optional(),
        participantRole: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const conversation = await ergataiFetch<BackendConversation>(
        "/api/v1/conversations",
        {
          method: "POST",
          body: JSON.stringify({
            chat_id: input.chatId,
            collaboration_session_id: input.collaborationSessionId,
            name: input.title,
            mode: input.mode,
            participant_role: input.participantRole,
          }),
        },
      )
      return mapConversation(conversation)
    }),



  /** Get a persisted conversation */
  getConversation: publicProcedure
    .input(z.object({ conversationId: conversationKeySchema }))
    .query(async ({ input }) => {
      try {
        const conversation = await ergataiFetch<BackendConversation>(
          `/api/v1/conversations/${encodeURIComponent(input.conversationId)}`,
        )
        return mapConversation(conversation)
      } catch (error) {
        if (isErgataiApiError(error) && error.status === 404) return null
        throw error
      }
    }),



  /** Update a persisted conversation */
  updateConversation: publicProcedure
    .input(
      z.object({
        conversationId: conversationKeySchema,
        title: z.string().optional(),
        mode: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      // Optimization: Skip update if title hasn't changed
      // This avoids redundant database writes when the same title is reported multiple times
      if (input.title !== undefined) {
        try {
          const existing = await ergataiFetch<BackendConversation>(
            `/api/v1/conversations/${encodeURIComponent(input.conversationId)}`,
            { method: "GET" },
          )
          if (existing.name === input.title) {
            // Title unchanged, skip the PATCH request
            return mapConversation(existing)
          }
        } catch {
          // If GET fails, proceed with PATCH (it might create the conversation)
        }
      }

      const conversation = await ergataiFetch<BackendConversation>(
        `/api/v1/conversations/${encodeURIComponent(input.conversationId)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ name: input.title, mode: input.mode }),
        },
      )
      return mapConversation(conversation)
    }),



  /** Delete a persisted conversation */
  deleteConversation: publicProcedure
    .input(z.object({ conversationId: conversationKeySchema }))
    .mutation(async ({ input }) => {
      await ergataiFetch(
        `/api/v1/conversations/${encodeURIComponent(input.conversationId)}`,
        { method: "DELETE" },
      )
      return { success: true }
    }),



  /** Archive a persisted conversation */
  archiveConversation: publicProcedure
    .input(z.object({ conversationId: conversationKeySchema }))
    .mutation(async ({ input }) => {
      const conversation = await ergataiFetch<BackendConversation>(
        `/api/v1/conversations/${encodeURIComponent(input.conversationId)}/archive`,
        { method: "POST" },
      )
      return mapConversation(conversation)
    }),



  /** Unarchive a persisted conversation */
  unarchiveConversation: publicProcedure
    .input(z.object({ conversationId: conversationKeySchema }))
    .mutation(async ({ input }) => {
      const conversation = await ergataiFetch<BackendConversation>(
        `/api/v1/conversations/${encodeURIComponent(input.conversationId)}/unarchive`,
        { method: "POST" },
      )
      return mapConversation(conversation)
    }),



  /** List messages in a conversation */
  listConversationMessages: publicProcedure
    .input(z.object({ conversationId: conversationKeySchema }))
    .query(async ({ input }) => {
      const messages = await ergataiFetch<BackendMessage[]>(
        `/api/v1/conversations/${encodeURIComponent(input.conversationId)}/messages`,
      )
      return messages.map(mapMessage)
    }),



  /**
   * Subscribe to real-time messages in a conversation (SSE)
   * Note: Requires backend to implement GET /api/v1/conversations/{id}/sse
   */
  subscribeConversationMessages: publicProcedure
    .input(
      z.object({
        conversationId: conversationKeySchema,
        afterSequence: z.number().optional(),
      }),
    )
    .subscription(({ input }) => {
      return observable<Message>((emit) => {
        const cleanup = subscribeConversationMessages(
          input.conversationId,
          input.afterSequence,
          (message) => {
            emit.next(mapMessage(message))
          },
          (error) => {
            emit.error(error)
          },
          () => {
            emit.complete()
          },
        )

        return () => {
          cleanup()
        }
      })
    }),



  /** List file changes derived from persisted conversation messages */
  listConversationFileChanges: publicProcedure
    .input(z.object({ conversationId: conversationKeySchema }))
    .query(async ({ input }) => {
      return ergataiFetch<BackendConversationFileChange[]>(
        `/api/v1/conversations/${encodeURIComponent(input.conversationId)}/file-changes`,
      )
    }),



  /** List conversations (替代旧的 runtime/conversations) */
  listConversations: publicProcedure
    .input(z.object({
      workspaceId: z.string().optional(),
      chatId: chatIdSchema.optional(),
      collaborationSessionId: z.string().optional(),
    }).optional())
    .query(async ({ input }) => {
      const params = new URLSearchParams()
      if (input?.workspaceId) params.set("workspace_id", input.workspaceId)
      if (input?.chatId) params.set("chat_id", input.chatId)
      if (input?.collaborationSessionId) params.set("collaboration_session_id", input.collaborationSessionId)
      const query = params.toString() ? `?${params.toString()}` : ""
      const conversations = await ergataiFetch<BackendConversation[]>(`/api/v1/conversations${query}`)
      return conversations.map(mapConversation)
    }),



  /** Get conversation detail (替代旧的 runtime/conversations/{id}) */
  getConversationDetail: publicProcedure
    .input(z.object({ conversationId: conversationKeySchema }))
    .query(async ({ input }) => {
      const conversation = await ergataiFetch<BackendConversation>(`/api/v1/conversations/${encodeURIComponent(input.conversationId)}`)
      return mapConversation(conversation)
    }),



  /** Allocate a backend message ID for optimistic/durable correlation */
  generateMessageId: publicProcedure.query(async () => {
    const result = await ergataiFetch<{ message_id: string }>("/api/v1/ids/message")
    return { id: result.message_id }
  }),



  /** Get ACP context window usage for a conversation */
  getConversationContextUsage: publicProcedure
    .input(
      z.object({
        conversationId: conversationKeySchema,
      }),
    )
    .query(async ({ input }) => {
      return ergataiFetch<{
        conversation_id: string
        context_used: number
        context_window: number
        percent_used: number
        updated_at: number
      }>(`/api/v1/conversations/${encodeURIComponent(input.conversationId)}/context-usage`)
    }),



  /** Get the backend's live cache for an active conversation turn */
  getConversationRuntime: publicProcedure
    .input(
      z.object({
        conversationId: conversationKeySchema,
        afterSequence: z.number().int().nonnegative().optional(),
      }),
    )
    .query(async ({ input }) => {
      const query = new URLSearchParams()
      if (input.afterSequence !== undefined) {
        query.set("after_sequence", String(input.afterSequence))
      }
      const suffix = query.toString() ? `?${query.toString()}` : ""
      return ergataiFetch<Record<string, unknown>>(
        `/api/v1/conversations/${encodeURIComponent(input.conversationId)}/runtime${suffix}`,
      )
    }),



  /** Stream the backend conversation runtime cache with snapshot + live events */
  subscribeConversationRuntime: publicProcedure
    .input(
      z.object({
        conversationId: conversationKeySchema,
        afterSequence: z.number().int().nonnegative().optional(),
      }),
    )
    .subscription(({ input }) => {
      return observable<ConversationRuntimeStreamEvent>((emit) => {
        return subscribeConversationRuntime(
          input.conversationId,
          input.afterSequence,
          (snapshot) => emit.next({ kind: "snapshot", snapshot }),
          (event) => emit.next({ kind: "event", event }),
          (error) => emit.error(error),
        )
      })
    }),



  // ── Conversation Related (5 endpoints) ─────────────────────────────────

  /** Get conversation outputs */
  getConversationOutputs: publicProcedure
    .input(z.object({ conversationId: conversationKeySchema }))
    .query(async ({ input }) => {
      return ergataiFetch(`/api/v1/conversations/${encodeURIComponent(input.conversationId)}/outputs`)
    }),



  /** Get specific conversation output */
  getConversationOutput: publicProcedure
    .input(z.object({
      conversationId: conversationKeySchema,
      outputId: z.string(),
    }))
    .query(async ({ input }) => {
      return ergataiFetch(`/api/v1/conversations/${encodeURIComponent(input.conversationId)}/outputs/${encodeURIComponent(input.outputId)}`)
    }),



  /** Get conversation file changes */
  getConversationFileChanges: publicProcedure
    .input(z.object({ conversationId: conversationKeySchema }))
    .query(async ({ input }) => {
      return ergataiFetch(`/api/v1/conversations/${encodeURIComponent(input.conversationId)}/file-changes`)
    }),


})
