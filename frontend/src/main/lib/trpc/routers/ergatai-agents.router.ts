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

export const agentsRouter = router({
  /** List all agents from Ergatai backend */
  listAgents: publicProcedure.query(async () => {
    return ergataiFetch<z.infer<typeof AgentInfoSchema>[]>("/api/v1/agents")
  }),



  /** Get a single agent by ID */
  getAgent: publicProcedure
    .input(z.object({ agentId: agentIdSchema }))
    .query(async ({ input }) => {
      const agents = await ergataiFetch<z.infer<typeof AgentInfoSchema>[]>("/api/v1/agents")
      return agents.find((a) => a.agent_id === input.agentId) ?? null
    }),



  /** Spawn a new agent */
  spawnAgent: publicProcedure
    .input(
      z.object({
        workspaceId: z.string().optional(),
        conversationId: conversationKeySchema.optional(),
        temporaryAgent: z.boolean().optional(),
        command: z.string(),
        instruction: z.string().optional(),
        workDir: z.string().optional(),
        env: z.record(z.string(), z.string()).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      console.log("[tRPC spawnAgent] Input:", JSON.stringify(input))
      try {
        // Ensure workDir exists - use ~/.ergatai as default if not provided
        let workDir = input.workDir
        if (!workDir) {
          // Use user's home directory instead of /tmp for persistence
          const homeDir = process.env.HOME || process.env.USERPROFILE || tmpdir()
          workDir = join(homeDir, ".ergatai")
          await mkdir(workDir, { recursive: true })
          console.log("[tRPC spawnAgent] Using default workDir:", workDir)
        }

        const response = await ergataiFetch<{
          agent_id?: string
          agentId?: string
        }>("/api/v1/agents", {
          method: "POST",
          body: JSON.stringify({
            workspace_id: input.workspaceId,
            conversation_id: input.conversationId,
            temporary_agent: input.temporaryAgent,
            command: input.command,
            instruction: input.instruction,
            work_dir: workDir,
            env: input.env,
          }),
        })
        console.log("[tRPC spawnAgent] Backend response:", JSON.stringify(response))
        const agentId = response?.agent_id ?? response?.agentId
        if (!agentId) {
          console.error("[tRPC spawnAgent] No agent_id in response. Response was:", response)
          throw new Error("Ergatai backend did not return an agent ID")
        }
        return { agent_id: agentId }
      } catch (error) {
        console.error("[tRPC spawnAgent] Error:", error)
        throw error
      }
    }),



  /** Kill an agent */
  killAgent: publicProcedure
    .input(z.object({ agentId: agentIdSchema }))
    .mutation(async ({ input }) => {
      await ergataiFetch(`/api/v1/agents/${input.agentId}`, {
        method: "DELETE",
      })
      return { success: true }
    }),



  /** Send a message to an agent */
  sendMessage: publicProcedure
    .input(
      z.object({
        agentId: agentIdSchema,
        message: z.string(),
        from: z.string().optional(),
        messageType: z.enum(["request", "response", "broadcast"]).optional(),
        correlationId: z.string().optional(),
        // Agent-to-agent routing fields
        targetAgentCommand: z.string().optional(),  // Target agent type (e.g., "claude", "codex")
        forceNewSession: z.boolean().optional(),    // Force spawn new session
        conversationId: conversationKeySchema.optional(),      // Required for agent-to-agent routing
        clientRequestId: clientRequestIdSchema.optional(), // Persisted/backend-allocated message ID
      }),
    )
    .mutation(async ({ input }) => {
      const body: Record<string, unknown> = {
        message: input.message,
        from: input.from,
        message_type: input.messageType,
        correlation_id: input.correlationId,
      }

      // Add agent-to-agent routing fields if present
      if (input.targetAgentCommand) {
        body.target_agent_command = input.targetAgentCommand
      }
      if (input.forceNewSession !== undefined) {
        body.force_new_session = input.forceNewSession
      }
      if (input.conversationId) {
        body.conversation_id = input.conversationId
      }
      if (input.clientRequestId) {
        body.client_request_id = input.clientRequestId
      }

      return ergataiFetch(`/api/v1/agents/${input.agentId}/send`, {
        method: "POST",
        body: JSON.stringify(body),
      })
    }),



  // ── Agent Monitoring Endpoints ──────────────────────────────────────────

  /** Get agent plan */
  getAgentPlan: publicProcedure
    .input(z.object({ agentId: agentIdSchema }))
    .query(async ({ input }): Promise<AgentPlan | null> => {
      try {
        return await ergataiFetch<AgentPlan>(`/api/v1/agents/${input.agentId}/plan`)
      } catch (error) {
        // Return null if plan not found or API error
        return null
      }
    }),



  /** List all agent bindings for a chat (use /agents endpoint) */
  getAgentBindings: publicProcedure
    .input(z.object({ chatId: chatIdSchema }))
    .query(async ({ input }): Promise<AgentBinding[]> => {
      if (!isValidChatId(input.chatId, "getAgentBindings")) {
        return []
      }

      // Use the /agents endpoint to get associated agents
      try {
        const response = await ergataiFetch<{
          agents: Array<{
            agent_id: string
            conversation_id: string
            state: string
            profile: string | null
            last_heartbeat: string
            // Binding creation/update times (Unix seconds). Prefer these over
            // last_heartbeat for createdAt/updatedAt semantics — last_heartbeat
            // reflects agent activity, not when the binding was created.
            created_at?: number
            updated_at?: number
          }>
        }>(`/api/v1/chats/${encodeURIComponent(input.chatId)}/agents`, {
          silentStatus: [404],
        })
        const agents = response.agents
        return agents.map((agent) => {
          // Use binding's created_at/updated_at when available; fall back to
          // last_heartbeat (backwards-compatible with older backend responses).
          // last_heartbeat arrives as an RFC 3339 string; created_at as Unix seconds.
          const createdAtMs = agent.created_at
            ? agent.created_at * 1000
            : Date.parse(agent.last_heartbeat) || Date.now()
          const updatedAtMs = agent.updated_at
            ? agent.updated_at * 1000
            : createdAtMs
          return {
            id: agent.agent_id,
            workspaceId: "",
            chatId: input.chatId,
            agentId: agent.agent_id,
            agentName: agent.profile ?? agent.agent_id,
            agentCommand: agent.profile,
            conversationId: agent.conversation_id ?? "",
            createdAt: new Date(createdAtMs),
            updatedAt: new Date(updatedAtMs),
          }
        })
      } catch (err) {
        if (isErgataiApiError(err) && err.status === 404) return []
        console.warn("[ergatai] getAgentBindings failed:", err)
        return []
      }
    }),



  // ── Agent Introspection Endpoints ────────────────────────────────────────

  /** Get agent elicitations (pending interactive requests) */
  getAgentElicitations: publicProcedure
    .input(z.object({ agentId: agentIdSchema }))
    .query(async ({ input }) => {
      return ergataiFetch(`/api/v1/agents/${input.agentId}/elicitations`)
    }),



  /** Respond to an agent elicitation */
  respondToElicitation: publicProcedure
    .input(
      z.object({
        agentId: agentIdSchema,
        elicitationId: z.string(),
        response: z.unknown(),
      }),
    )
    .mutation(async ({ input }) => {
      return ergataiFetch(
        `/api/v1/agents/${input.agentId}/elicitations/${input.elicitationId}/respond`,
        {
          method: "POST",
          body: JSON.stringify(input.response),
        },
      )
    }),



  /** Get pending permission requests (unified approval feed) */
  getPendingPermissions: publicProcedure.query(async () => {
    return ergataiFetch("/api/v1/permissions/pending")
  }),



  /** Respond to a pending permission request */
  respondPermission: publicProcedure
    .input(
      z.object({
        requestId: z.string(),
        decision: z.enum(["allow_once", "allow_always", "reject_once", "reject_always"]),
        formData: z.unknown().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      return ergataiFetch(
        `/api/v1/permissions/${encodeURIComponent(input.requestId)}/respond`,
        {
          method: "POST",
          body: JSON.stringify({
            decision: input.decision,
            form_data: input.formData,
          }),
        },
      )
    }),



  /** Subscribe to real-time permission lifecycle events */
  subscribePermissions: publicProcedure.subscription(() => {
    return observable<
      | {
          type: "permission_request"
          requestId: string
          kind: "tool" | "mcp-server"
          source: "acp" | "elicitation" | "launch-gate"
          agentId?: string | null
          sessionId?: string | null
          title: string
          toolName?: string | null
          input?: unknown
          locations?: string[]
          createdAtMs: number
        }
      | { type: "permission_resolved"; requestId: string; decision: string }
    >((emit) => {
      const abortController = new AbortController()
      let cleanedUp = false

      const cleanup = () => {
        if (cleanedUp) return
        cleanedUp = true
        abortController.abort()
      }

      const parseEvent = (rawEvent: string): { event: string; data: string } | null => {
        let event = "message"
        const data = rawEvent
          .split("\n")
          .filter((line) => {
            if (line.startsWith("event:")) {
              const value = line.slice(6)
              event = value.startsWith(" ") ? value.slice(1) : value
              return false
            }
            return line.startsWith("data:")
          })
          .map((line) => {
            const value = line.slice(5)
            return value.startsWith(" ") ? value.slice(1) : value
          })
          .join("\n")

        if (!data) return null
        return { event, data }
      }

      void (async () => {
        try {
          const { apiUrl, token } = getErgataiAuthConfig()
          const response = await fetch(`${apiUrl}/api/v1/permissions/stream`, {
            headers: {
              Accept: "text/event-stream",
              Authorization: `Bearer ${token}`,
            },
            signal: abortController.signal,
          })

          if (!response.ok) {
            const detail = await response.text().catch(() => "unknown error")
            throw new Error(`Permission stream failed (${response.status}): ${detail}`)
          }
          if (!response.body) {
            throw new Error("Permission stream response has no readable body")
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
              const parsed = parseEvent(rawEvent)
              if (!parsed) continue
              const payload = JSON.parse(parsed.data)
              const type = typeof payload.type === "string" ? payload.type : parsed.event
              if (type === "permission_request" || type === "permission_resolved") {
                emit.next({ ...payload, type })
              }
            }
          }

          emit.complete()
        } catch (err) {
          if (!abortController.signal.aborted) {
            emit.error(err instanceof Error ? err : new Error("Permission stream failed"))
          }
        }
      })()

      return cleanup
    })
  }),



  /** Get the current permission mode (ask | auto | full_access) */
  getPermissionMode: publicProcedure.query(async () => {
    return ergataiFetch("/api/v1/permissions/mode")
  }),



  /** Switch the permission mode */
  setPermissionMode: publicProcedure
    .input(z.object({ mode: z.enum(["ask", "auto", "full_access"]) }))
    .mutation(async ({ input }) => {
      return ergataiFetch("/api/v1/permissions/mode", {
        method: "POST",
        body: JSON.stringify(input),
      })
    }),



  /** Get agent config options */
  getAgentConfigOptions: publicProcedure
    .input(z.object({ agentId: agentIdSchema }))
    .query(async ({ input }) => {
      return ergataiFetch(`/api/v1/agents/${input.agentId}/config-options`)
    }),



  /** Get agent available commands */
  getAgentCommands: publicProcedure
    .input(z.object({ agentId: agentIdSchema }))
    .query(async ({ input }) => {
      return ergataiFetch(`/api/v1/agents/${input.agentId}/commands`)
    }),



  /** Execute an agent command */
  executeAgentCommand: publicProcedure
    .input(
      z.object({
        agentId: agentIdSchema,
        command: z.string(),
        args: z.array(z.string()).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      return ergataiFetch(`/api/v1/agents/${input.agentId}/execute-command`, {
        method: "POST",
        body: JSON.stringify({
          command: input.command,
          args: input.args ?? [],
        }),
      })
    }),



  /**
   * @deprecated Use `getAgentProfileModels` instead.
   * This procedure reads from the old JSON snapshot store.
   * Kept for backward compatibility only — will be removed after migration.
   */
  /** Get latest cached models (no agent required — reads from snapshot store) */
  getLatestCachedModels: publicProcedure.query(async () => {
    const manager = getModelSnapshotManager()
    await manager.initialize()

    // Get the most recent snapshot from the store
    const snapshots = await loadSnapshots()
    const entries = Object.entries(snapshots)

    if (entries.length === 0) {
      return { models: [], current: undefined }
    }

    // Find the most recently updated snapshot
    const latest = entries.reduce((a, b) =>
      (a[1].timestamp > b[1].timestamp ? a : b)
    )

    return {
      models: latest[1].models,
      current: latest[1].current,
      cacheKey: latest[0],
    }
  }),



  /**
   * @deprecated Use `refreshAgentProfileModels` instead.
   * This procedure writes to the old JSON snapshot store.
   * Kept for backward compatibility only — will be removed after migration.
   */
  /** Save model snapshot to SQLite cache */
  saveModelSnapshot: publicProcedure
    .input(
      z.object({
        cacheKey: z.string(),
        models: z.array(z.string()),
        current: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const manager = getModelSnapshotManager()
      await manager.saveSnapshot(input.cacheKey, input.models, input.current, false)
      return { success: true }
    }),



  /**
   * @deprecated Use `getAgentProfileModels` + `refreshAgentProfileModels` instead.
   * This procedure uses the old JSON snapshot store.
   * Kept for backward compatibility only — will be removed after migration.
   */
  /** Get agent models with cache support */
  getAgentModelsWithCache: publicProcedure
    .input(
      z.object({
        agentId: agentIdSchema,
        forceRefresh: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      // Get agent details
      const agents = await ergataiFetch<z.infer<typeof AgentInfoSchema>[]>("/api/v1/agents")
      const agent = agents.find((a) => a.agent_id === input.agentId)

      if (!agent) {
        throw new Error(`Agent ${input.agentId} not found`)
      }

      // Get model snapshot manager
      const manager = getModelSnapshotManager()

      // Get models with cache support
      const result = await manager.getModelsWithCache(agent, input.forceRefresh)

      return {
        models: result.models,
        current: result.current,
        isCached: result.isCached,
        isStale: result.isStale,
        timestamp: result.timestamp,
      }
    }),



  /** Get agent sessions */
  listAgentSessions: publicProcedure
    .input(z.object({ agentId: agentIdSchema }))
    .query(async ({ input }) => {
      return ergataiFetch(`/api/v1/agents/${input.agentId}/sessions`)
    }),



  /** Create an agent session */
  createAgentSession: publicProcedure
    .input(z.object({ agentId: agentIdSchema }))
    .mutation(async ({ input }) => {
      return ergataiFetch(`/api/v1/agents/${input.agentId}/sessions`, {
        method: "POST",
      })
    }),



  /** Load a specific agent session */
  loadAgentSession: publicProcedure
    .input(z.object({ agentId: agentIdSchema, sessionId: z.string() }))
    .mutation(async ({ input }) => {
      return ergataiFetch(
        `/api/v1/agents/${input.agentId}/sessions/${input.sessionId}`,
        { method: "POST" },
      )
    }),



  /** Delete a specific agent session */
  deleteAgentSession: publicProcedure
    .input(z.object({ agentId: agentIdSchema, sessionId: z.string() }))
    .mutation(async ({ input }) => {
      await ergataiFetch(
        `/api/v1/agents/${input.agentId}/sessions/${input.sessionId}`,
        { method: "DELETE" },
      )
      return { success: true }
    }),



  // ── Agent Profile Models ──────────────────────────────────────────────────

  /** Get cached models for an agent profile */
  getAgentProfileModels: publicProcedure
    .input(z.object({ profileName: z.string() }))
    .query(async ({ input }) => {
      try {
        return await ergataiFetch<{
          models: string[]
          current: string | null
          updated_at: number | null
        }>(`/api/v1/agent-profiles/${encodeURIComponent(input.profileName)}/models`)
      } catch {
        return { models: [], current: null, updated_at: null }
      }
    }),



  /** Trigger model detection for an agent profile */
  refreshAgentProfileModels: publicProcedure
    .input(z.object({ profileName: z.string() }))
    .mutation(async ({ input }) => {
      return ergataiFetch<{
        status: string
        models: string[]
        current: string | null
      }>(`/api/v1/agent-profiles/${encodeURIComponent(input.profileName)}/models/refresh`, {
        method: "POST",
      })
    }),



  // ── Lock Monitoring Endpoints ────────────────────────────────────────────

  /** List all active file locks */
  listLocks: publicProcedure.query(async (): Promise<LockInfo[]> => {
    return ergataiFetch<LockInfo[]>("/api/v1/locks")
  }),



  /** Query file lock audit log */
  listLockAudit: publicProcedure
    .input(
      z.object({
        agentId: agentIdSchema.optional(),
        action: z.string().optional(),
        filePath: z.string().optional(),
        limit: z.number().optional(),
      }).optional(),
    )
    .query(async ({ input }): Promise<LockAuditEntry[]> => {
      const params = new URLSearchParams()
      if (input?.agentId) params.set("agent_id", input.agentId)
      if (input?.action) params.set("action", input.action)
      if (input?.filePath) params.set("file_path", input.filePath)
      if (input?.limit) params.set("limit", String(input.limit))
      const query = params.toString()
      return ergataiFetch<LockAuditEntry[]>(
        `/api/v1/locks/audit${query ? `?${query}` : ""}`,
      )
    }),



  /** Get lock contention information */
  getLockContention: publicProcedure.query(async (): Promise<LockContention[]> => {
    return ergataiFetch<LockContention[]>("/api/v1/locks/contention")
  }),



  // ── Missing Backend API Endpoints (46 total) ─────────────────────────────

  // ── Agent Management (8 endpoints) ─────────────────────────────────────

  /** List suspended agents */
  listSuspendedAgents: publicProcedure.query(async () => {
    return ergataiFetch("/api/v1/agents/suspended")
  }),



  /** Get agent events stream */
  getAgentEvents: publicProcedure
    .input(z.object({ agentId: agentIdSchema }))
    .query(async ({ input }) => {
      return ergataiFetch(`/api/v1/agents/${input.agentId}/events`)
    }),



  /** Send prompt to agent */
  sendPrompt: publicProcedure
    .input(z.object({
      agentId: agentIdSchema,
      prompt: z.string(),
    }))
    .mutation(async ({ input }) => {
      return ergataiFetch(`/api/v1/agents/${input.agentId}/prompt`, {
        method: "POST",
        body: JSON.stringify({ prompt: input.prompt }),
      })
    }),



  /** Resume agent */
  resumeAgent: publicProcedure
    .input(z.object({ agentId: agentIdSchema }))
    .mutation(async ({ input }) => {
      return ergataiFetch(`/api/v1/agents/${input.agentId}/resume`, {
        method: "POST",
      })
    }),



  /** Spawn new agent session */
  spawnNewAgentSession: publicProcedure
    .input(z.object({ agentId: agentIdSchema }))
    .mutation(async ({ input }) => {
      return ergataiFetch(`/api/v1/agents/${input.agentId}/fork`, {
        method: "POST",
      })
    }),



  /** Suspend agent */
  suspendAgent: publicProcedure
    .input(z.object({ agentId: agentIdSchema }))
    .mutation(async ({ input }) => {
      return ergataiFetch(`/api/v1/agents/${input.agentId}/suspend`, {
        method: "POST",
      })
    }),



  // ── Other (3 endpoints) ────────────────────────────────────────────────

  /** Get locks audit log */
  getLocksAudit: publicProcedure.query(async () => {
    return ergataiFetch("/api/v1/locks/audit")
  }),



  /** Subscribe to permissions stream */
  subscribePermissionsStream: publicProcedure.subscription(() => {
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
          const response = await fetch(`${apiUrl}/api/v1/permissions/stream`, {
            headers: {
              Accept: "text/event-stream",
              Authorization: `Bearer ${token}`,
            },
            signal: abortController.signal,
          })

          if (!response.ok) {
            const detail = await response.text().catch(() => "unknown error")
            throw new Error(`Permissions stream failed (${response.status}): ${detail}`)
          }
          if (!response.body) {
            throw new Error("Permissions stream has no readable body")
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
            emit.error(error instanceof Error ? error : new Error("Permissions stream failed"))
          }
        }
      })()

      return cleanup
    })
  }),



  /** Respond to permission request */
  respondToPermission: publicProcedure
    .input(z.object({
      permissionId: z.string(),
      response: z.unknown(),
    }))
    .mutation(async ({ input }) => {
      return ergataiFetch(`/api/v1/permissions/${encodeURIComponent(input.permissionId)}/respond`, {
        method: "POST",
        body: JSON.stringify(input.response),
      })
    }),


})
