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

export const statusRouter = router({

  /** Get system status */
  getStatus: publicProcedure.query(async () => {
    return ergataiFetch("/api/v1/status")
  }),



  /** Health check */
  healthCheck: publicProcedure.query(async () => {
    try {
      return await ergataiFetch("/health")
    } catch {
      return { status: "unhealthy", error: "Cannot connect to Ergatai backend" }
    }
  }),



  // ── System Config & Stats Endpoints ─────────────────────────────────────

  /** Get backend system configuration */
  getSystemConfig: publicProcedure.query(async (): Promise<SystemConfig> => {
    return ergataiFetch<SystemConfig>("/api/v1/system/config")
  }),



  // ── Activity Feed Endpoints ──────────────────────────────────────────────

  /** Get recent activity events */
  getActivity: publicProcedure
    .input(z.object({ limit: z.number().optional() }).optional())
    .query(async ({ input }) => {
      const limit = input?.limit ?? 50
      return ergataiFetch(`/api/v1/activity/recent?limit=${limit}`)
    }),



  /** Subscribe to activity feed events (SSE) */
  subscribeActivity: publicProcedure.subscription(() => {
    return observable<BackendActivityEntry>((emit) => {
      const abortController = new AbortController()
      let cleanedUp = false

      const cleanup = () => {
        if (cleanedUp) return
        cleanedUp = true
        abortController.abort()
      }

      const parseEvent = (rawEvent: string): BackendActivityEntry | null => {
        const data = rawEvent
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => {
            const value = line.slice(5)
            return value.startsWith(" ") ? value.slice(1) : value
          })
          .join("\n")

        if (!data) return null
        return JSON.parse(data) as BackendActivityEntry
      }

      void (async () => {
        try {
          const { apiUrl, token } = getErgataiAuthConfig()
          const response = await fetch(`${apiUrl}/api/v1/activity/stream`, {
            headers: {
              Accept: "text/event-stream",
              Authorization: `Bearer ${token}`,
            },
            signal: abortController.signal,
          })

          if (!response.ok) {
            const detail = await response.text().catch(() => "unknown error")
            throw new Error(`Activity stream failed (${response.status}): ${detail}`)
          }
          if (!response.body) {
            throw new Error("Activity stream response has no readable body")
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
        } catch (err) {
          if (!abortController.signal.aborted) {
            emit.error(err instanceof Error ? err : new Error("Activity stream failed"))
          }
        }
      })()

      return cleanup
    })
  }),



  // ── Terminal Sessions (9 endpoints) ────────────────────────────────────

  /** List all terminal sessions */
  listTerminalSessions: publicProcedure.query(async () => {
    return ergataiFetch("/api/v1/terminal-sessions")
  }),



  /** Create terminal session */
  createTerminalSession: publicProcedure
    .input(z.object({
      workspaceId: z.string(),
      command: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      return ergataiFetch("/api/v1/terminal-sessions", {
        method: "POST",
        body: JSON.stringify(input),
      })
    }),



  /** Get terminal session details */
  getTerminalSession: publicProcedure
    .input(z.object({ sessionId: z.string() }))
    .query(async ({ input }) => {
      return ergataiFetch(`/api/v1/terminal-sessions/${encodeURIComponent(input.sessionId)}`)
    }),



  /** Stream terminal output */
  streamTerminalOutput: publicProcedure
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
              `${apiUrl}/api/v1/terminal-sessions/${encodeURIComponent(input.sessionId)}/stream`,
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
              throw new Error(`Terminal stream failed (${response.status}): ${detail}`)
            }
            if (!response.body) {
              throw new Error("Terminal stream has no readable body")
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
              emit.error(error instanceof Error ? error : new Error("Terminal stream failed"))
            }
          }
        })()

        return cleanup
      })
    }),



  /** Send input to terminal */
  sendTerminalInput: publicProcedure
    .input(z.object({
      sessionId: z.string(),
      input: z.string(),
    }))
    .mutation(async ({ input }) => {
      return ergataiFetch(`/api/v1/terminal-sessions/${encodeURIComponent(input.sessionId)}/input`, {
        method: "POST",
        body: JSON.stringify({ input: input.input }),
      })
    }),



  /** Resize terminal */
  resizeTerminal: publicProcedure
    .input(z.object({
      sessionId: z.string(),
      cols: z.number(),
      rows: z.number(),
    }))
    .mutation(async ({ input }) => {
      return ergataiFetch(`/api/v1/terminal-sessions/${encodeURIComponent(input.sessionId)}/resize`, {
        method: "POST",
        body: JSON.stringify({ cols: input.cols, rows: input.rows }),
      })
    }),



  /** Send signal to terminal */
  signalTerminal: publicProcedure
    .input(z.object({
      sessionId: z.string(),
      signal: z.string(),
    }))
    .mutation(async ({ input }) => {
      return ergataiFetch(`/api/v1/terminal-sessions/${encodeURIComponent(input.sessionId)}/signal`, {
        method: "POST",
        body: JSON.stringify({ signal: input.signal }),
      })
    }),



  /** Terminate terminal */
  terminateTerminal: publicProcedure
    .input(z.object({ sessionId: z.string() }))
    .mutation(async ({ input }) => {
      return ergataiFetch(`/api/v1/terminal-sessions/${encodeURIComponent(input.sessionId)}/terminate`, {
        method: "POST",
      })
    }),



  /** Get terminal audit log */
  getTerminalAudit: publicProcedure
    .input(z.object({ sessionId: z.string() }))
    .query(async ({ input }) => {
      return ergataiFetch(`/api/v1/terminal-sessions/${encodeURIComponent(input.sessionId)}/audit`)
    }),


})
