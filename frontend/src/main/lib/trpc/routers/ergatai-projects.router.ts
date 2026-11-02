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

export const projectsRouter = router({

  // ── Projects Endpoints ──────────────────────────────────────────────────
  // Note: Backend projects are workspace-scoped. These endpoints aggregate
  // across all managed workspaces to provide a "standalone" project view.

  /** List all projects (aggregated from all managed workspaces) */
  listProjects: publicProcedure.query(async (): Promise<Project[]> => {
    try {
      // Get all managed workspaces
      const workspaces = await ergataiFetch<BackendManagedWorkspace[]>(
        `/api/v1/workspaces/managed`,
      )
      // Aggregate projects from all workspaces
      const allProjects: Project[] = []
      for (const ws of workspaces) {
        try {
          const projects = await ergataiFetch<BackendWorkspaceProject[]>(
            `/api/v1/workspaces/managed/${encodeURIComponent(ws.workspace_id)}/projects`,
          )
          for (const p of projects) {
            allProjects.push(mapWorkspaceProjectToProject(p))
          }
        } catch (error) {
          // Skip workspaces that no longer exist or have invalid IDs
          console.warn(`[Projects] Failed to list projects for workspace ${ws.workspace_id}:`, error)
        }
      }
      return allProjects
    } catch (error) {
      console.error("[Projects] Failed to list projects:", error)
      return []
    }
  }),



  /** Get a project by ID (searches across all workspaces) */
  getProject: publicProcedure
    .input(z.object({ id: projectIdSchema }))
    .query(async ({ input }): Promise<Project | null> => {
      try {
        const workspaces = await ergataiFetch<BackendManagedWorkspace[]>(
          `/api/v1/workspaces/managed`,
        )
        for (const ws of workspaces) {
          try {
            const projects = await ergataiFetch<BackendWorkspaceProject[]>(
              `/api/v1/workspaces/managed/${encodeURIComponent(ws.workspace_id)}/projects`,
            )
            const found = projects.find((p) => p.project_id === input.id)
            if (found) {
              return mapWorkspaceProjectToProject(found)
            }
          } catch (error) {
            // Skip workspaces that no longer exist or have invalid IDs
            console.warn(`[Projects] Failed to list projects for workspace ${ws.workspace_id}:`, error)
          }
        }
        return null
      } catch (error) {
        console.error("[Projects] Failed to get project:", error)
        return null
      }
    }),



  /** Create a new project (auto-creates workspace if none exists) */
  createProject: publicProcedure
    .input(
      z.object({
        name: z.string(),
        path: z.string(),
        gitRemoteUrl: z.string().nullish(),
        gitProvider: z.string().nullish(),
        gitOwner: z.string().nullish(),
        gitRepo: z.string().nullish(),
        iconPath: z.string().nullish(),
      }),
    )
    .mutation(async ({ input }): Promise<Project> => {
      let workspaceId: string | null = null
      try {
        const workspaces = await ergataiFetch<BackendManagedWorkspace[]>(
          `/api/v1/workspaces/managed`,
        )
        // Use first existing workspace, or create one named after the project
        if (workspaces.length > 0) {
          workspaceId = workspaces[0]!.workspace_id.toString()
        } else {
          // Auto-create workspace named after the project
          const newWs = await ergataiFetch<BackendManagedWorkspace>(
            `/api/v1/workspaces/managed`,
            {
              method: "POST",
              body: JSON.stringify({
                name: input.name,
                work_dir: input.path,
              }),
            },
          )
          workspaceId = newWs.workspace_id.toString()
        }
      } catch (error) {
        console.error("[Projects] Failed to get/create workspace:", error)
        throw new Error("Failed to get workspace for project")
      }

      // Register the project to the workspace
      try {
        const project = await ergataiFetch<BackendWorkspaceProject>(
          `/api/v1/workspaces/managed/${encodeURIComponent(workspaceId)}/projects`,
          {
            method: "POST",
            body: JSON.stringify({
              name: input.name,
              path: input.path,
              git_remote_url: input.gitRemoteUrl,
              git_provider: input.gitProvider,
              git_owner: input.gitOwner,
              git_repo: input.gitRepo,
              icon_path: input.iconPath,
            }),
          },
        )

        // Set this project as the default project for the workspace
        if (project.project_id) {
          await ergataiFetch<BackendManagedWorkspace>(
            `/api/v1/workspaces/managed/${encodeURIComponent(workspaceId)}`,
            {
              method: "PATCH",
              body: JSON.stringify({
                default_project_id: project.project_id,
              }),
            },
          )
        }

        return mapWorkspaceProjectToProject(project)
      } catch (error) {
        console.error("[Projects] Failed to create project:", error)
        throw new Error(`Failed to create project: ${error instanceof Error ? error.message : String(error)}`)
      }
    }),



  /** Update a project */
  updateProject: publicProcedure
    .input(
      z.object({
        id: projectIdSchema,
        name: z.string().optional(),
        path: z.string().optional(),
        gitRemoteUrl: z.string().nullish(),
        gitProvider: z.string().nullish(),
        gitOwner: z.string().nullish(),
        gitRepo: z.string().nullish(),
        iconPath: z.string().nullish(),
      }),
    )
    .mutation(async ({ input }): Promise<Project | null> => {
      try {
        // Find which workspace contains this project
        const workspaces = await ergataiFetch<BackendManagedWorkspace[]>(
          `/api/v1/workspaces/managed`,
        )
        for (const ws of workspaces) {
          const wsId = ws.workspace_id.toString()
          const projects = await ergataiFetch<BackendWorkspaceProject[]>(
            `/api/v1/workspaces/managed/${encodeURIComponent(wsId)}/projects`,
          )
          const found = projects.find((p) => p.project_id === input.id)
          if (found) {
            // Build update payload (only include fields that are explicitly provided)
            const updatePayload: Record<string, unknown> = {}
            if (input.name !== undefined) updatePayload.name = input.name
            if (input.path !== undefined) updatePayload.path = input.path
            // Git fields: use undefined to skip, null to clear, string to set
            if (input.gitRemoteUrl !== undefined) updatePayload.git_remote_url = input.gitRemoteUrl
            if (input.gitProvider !== undefined) updatePayload.git_provider = input.gitProvider
            if (input.gitOwner !== undefined) updatePayload.git_owner = input.gitOwner
            if (input.gitRepo !== undefined) updatePayload.git_repo = input.gitRepo
            if (input.iconPath !== undefined) updatePayload.icon_path = input.iconPath

            const updated = await ergataiFetch<BackendWorkspaceProject>(
              `/api/v1/workspaces/managed/${encodeURIComponent(wsId)}/projects/${encodeURIComponent(input.id)}`,
              {
                method: "PATCH",
                body: JSON.stringify(updatePayload),
              },
            )
            return mapWorkspaceProjectToProject(updated)
          }
        }
        return null
      } catch (error) {
        console.error("[Projects] Failed to update project:", error)
        return null
      }
    }),



  /** Delete a project (finds workspace and removes) */
  deleteProject: publicProcedure
    .input(z.object({ id: projectIdSchema }))
    .mutation(async ({ input }): Promise<{ success: boolean }> => {
      try {
        const workspaces = await ergataiFetch<BackendManagedWorkspace[]>(
          `/api/v1/workspaces/managed`,
        )
        for (const ws of workspaces) {
          const wsId = ws.workspace_id.toString()
          const projects = await ergataiFetch<BackendWorkspaceProject[]>(
            `/api/v1/workspaces/managed/${encodeURIComponent(wsId)}/projects`,
          )
          const found = projects.find((p) => p.project_id === input.id)
          if (found) {
            await ergataiFetch(
              `/api/v1/workspaces/managed/${encodeURIComponent(wsId)}/projects/${encodeURIComponent(input.id)}`,
              { method: "DELETE" },
            )
            return { success: true }
          }
        }
        return { success: false }
      } catch (error) {
        console.error("[Projects] Failed to delete project:", error)
        return { success: false }
      }
    }),


})
