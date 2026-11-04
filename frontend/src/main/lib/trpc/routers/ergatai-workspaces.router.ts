import {
  BackendChat,
  BackendManagedWorkspace,
  BackendWorkspaceProject,
  BackendWorkspaceStatus,
  ErgataiApiError,
  Workspace,
  chatIdSchema,
  ergataiFetch,
  isValidChatId,
  mapManagedWorkspace,
  mapWorkspaceProject,
  mapWorkspaceStatus,
  projectIdSchema,
  publicProcedure,
  router,
  terminalManager,
  z,
} from "./ergatai-shared"

export const workspacesRouter = router({

  /** List managed workspaces */
  listManagedWorkspaces: publicProcedure
    .input(
      z.object({
        collaborationMode: z.enum(["supervisor", "group"]).optional(),
      }).optional(),
    )
    .query(async ({ input }) => {
      const query = input?.collaborationMode
        ? `?collaboration_mode=${encodeURIComponent(input.collaborationMode)}`
        : ""
      const workspaces = await ergataiFetch<BackendManagedWorkspace[]>(
        `/api/v1/workspaces/managed${query}`,
      )
      const filteredWorkspaces = input?.collaborationMode
        ? workspaces.filter(
            (workspace) =>
              workspace.collaboration_mode === input.collaborationMode,
          )
        : workspaces
      return filteredWorkspaces.map(mapManagedWorkspace)
    }),



  /** List archived managed workspaces */
  listArchivedWorkspaces: publicProcedure
    .input(
      z.object({
        collaborationMode: z.enum(["supervisor", "group"]).optional(),
      }).optional(),
    )
    .query(async ({ input }) => {
      const query = new URLSearchParams()
      if (input?.collaborationMode) {
        query.set("collaboration_mode", input.collaborationMode)
      }
      query.set("archived", "true")

      const workspaces = await ergataiFetch<BackendManagedWorkspace[]>(
        `/api/v1/workspaces/managed?${query.toString()}`,
      )
      return workspaces.map(mapManagedWorkspace)
    }),



  /** Get a managed workspace by ID */
  getManagedWorkspace: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      try {
        const workspace = await ergataiFetch<BackendManagedWorkspace>(
          `/api/v1/workspaces/managed/${encodeURIComponent(input.id)}`,
          { silentStatus: [404] } // Suppress 404 logs - expected for stale localStorage IDs
        )
        return mapManagedWorkspace(workspace)
      } catch (error) {
        // Return null for 404 errors (workspace no longer exists)
        // This can happen when localStorage has a stale workspace ID
        if (error instanceof ErgataiApiError && error.status === 404) {
          return null
        }
        throw error
      }
    }),



  /** Create a managed workspace */
  createManagedWorkspace: publicProcedure
    .input(
      z.object({
        id: z.string().optional(),
        name: z.string().optional(),
        workDir: z.string(),
        projectId: projectIdSchema.optional(),
        projectPath: z.string().optional(),
        projectName: z.string().optional(),
        env: z.record(z.string(), z.string()).optional(),
        resources: z.record(z.string(), z.unknown()).optional(),
        captureThoughts: z.boolean().optional(),
        collaborationMode: z.enum(["supervisor", "group"]).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const workspace = await ergataiFetch<BackendManagedWorkspace>(
        "/api/v1/workspaces/managed",
        {
          method: "POST",
          body: JSON.stringify({
            id: input.id,
            name: input.name,
            work_dir: input.workDir,
            project_id: input.projectId,
            project_path: input.projectPath,
            project_name: input.projectName,
            env: input.env,
            resources: input.resources,
            capture_thoughts: input.captureThoughts ?? false,
            collaboration_mode: input.collaborationMode ?? "supervisor",
          }),
        },
      )
      return mapManagedWorkspace(workspace)
    }),



  /** Update a managed workspace */
  updateManagedWorkspace: publicProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().optional(),
        workDir: z.string().optional(),
        env: z.record(z.string(), z.string()).optional(),
        resources: z.record(z.string(), z.unknown()).optional(),
        captureThoughts: z.boolean().optional(),
        status: z.string().optional(),
        defaultProjectId: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const workspace = await ergataiFetch<BackendManagedWorkspace>(
        `/api/v1/workspaces/managed/${encodeURIComponent(input.id)}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            name: input.name,
            work_dir: input.workDir,
            env: input.env,
            resources: input.resources,
            capture_thoughts: input.captureThoughts,
            status: input.status,
            default_project_id: input.defaultProjectId,
          }),
        },
      )
      return mapManagedWorkspace(workspace)
    }),



  /** Set the default project for a workspace (shown on workspace open) */
  setDefaultProject: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        projectId: z.string().nullable(), // null to clear
      }),
    )
    .mutation(async ({ input }) => {
      const workspace = await ergataiFetch<BackendManagedWorkspace>(
        `/api/v1/workspaces/managed/${encodeURIComponent(input.workspaceId)}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            default_project_id: input.projectId,
          }),
        },
      )
      return mapManagedWorkspace(workspace)
    }),



  /** Archive a managed workspace */
  /** Delete a managed workspace */
  deleteManagedWorkspace: publicProcedure
    .input(
      z.object({
        id: z.string(),
        force: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const query = input.force ? "?force=true" : ""

      // Only check for active agents if force is not specified
      // When force=true, let the backend handle stopping agents automatically
      if (!input.force) {
        const status = await ergataiFetch<BackendWorkspaceStatus>(
          `/api/v1/workspaces/managed/${encodeURIComponent(input.id)}/status`,
        )
        if (status.active_agent_count > 0) {
          throw new Error(
            "Workspace has active agents running; stop them before deletion",
          )
        }

        // Only kill terminal sessions if not forcing
        const chats = await ergataiFetch<BackendChat[]>(
          `/api/v1/chats?workspace_id=${encodeURIComponent(input.id)}`,
        )
        const terminalWorkspaceIds = [
          ...new Set(
            chats.flatMap(chat => [chat.id, chat.worktree_path].filter(Boolean) as string[]),
          ),
        ]
        await Promise.all(
          terminalWorkspaceIds.map(id => terminalManager.killByWorkspaceId(id)),
        )
      }

      await ergataiFetch(
        `/api/v1/workspaces/managed/${encodeURIComponent(input.id)}${query}`,
        { method: "DELETE" },
      )
    }),



  /** Archive a managed workspace */
  archiveManagedWorkspace: publicProcedure
    .input(z.object({
      workspaceId: z.string(),
      force: z.boolean().optional(),
    }))
    .mutation(async ({ input }) => {
      const query = input.force ? "?force=true" : ""
      return ergataiFetch(`/api/v1/workspaces/managed/${encodeURIComponent(input.workspaceId)}/archive${query}`, {
        method: "POST",
      })
    }),



  /** Restore a managed workspace */
  restoreManagedWorkspace: publicProcedure
    .input(z.object({
      workspaceId: z.string(),
    }))
    .mutation(async ({ input }) => {
      return ergataiFetch(`/api/v1/workspaces/managed/${encodeURIComponent(input.workspaceId)}/restore`, {
        method: "POST",
      })
    }),



  /** List projects registered in a managed workspace */
  listWorkspaceProjects: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      const projects = await ergataiFetch<BackendWorkspaceProject[]>(
        `/api/v1/workspaces/managed/${encodeURIComponent(input.id)}/projects`,
      )
      return projects.map(mapWorkspaceProject)
    }),



  /** Register a project with a managed workspace */
  registerWorkspaceProject: publicProcedure
    .input(
      z.object({
        id: z.string(),
        projectId: projectIdSchema.optional(),
        projectPath: z.string().optional(),
        projectName: z.string().optional(),
        isDefault: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const workspace = await ergataiFetch<BackendManagedWorkspace>(
        `/api/v1/workspaces/managed/${encodeURIComponent(input.id)}/projects`,
        {
          method: "POST",
          body: JSON.stringify({
            project_id: input.projectId,
            project_path: input.projectPath,
            project_name: input.projectName,
            is_default: input.isDefault ?? false,
          }),
        },
      )
      return mapManagedWorkspace(workspace)
    }),



  /** Remove a project registration from a managed workspace */
  removeWorkspaceProject: publicProcedure
    .input(
      z.object({
        id: z.string(),
        projectId: projectIdSchema,
      }),
    )
    .mutation(async ({ input }) => {
      const workspace = await ergataiFetch<BackendManagedWorkspace>(
        `/api/v1/workspaces/managed/${encodeURIComponent(input.id)}/projects/${encodeURIComponent(input.projectId)}`,
        { method: "DELETE" },
      )
      return mapManagedWorkspace(workspace)
    }),



  /** Get aggregate runtime status for a managed workspace */
  workspaceStatus: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      const status = await ergataiFetch<BackendWorkspaceStatus>(
        `/api/v1/workspaces/managed/${encodeURIComponent(input.id)}/status`,
      )
      const chats = await ergataiFetch<BackendChat[]>(
        `/api/v1/chats?workspace_id=${encodeURIComponent(input.id)}`,
      )
      const terminalWorkspaceIds = [
        ...new Set(
          chats.flatMap(chat => [chat.id, chat.worktree_path].filter(Boolean) as string[]),
        ),
      ]
      const terminalCount = terminalWorkspaceIds.reduce(
        (count, workspaceId) => count + terminalManager.getSessionCountByWorkspaceId(workspaceId),
        0,
      )
      const mapped = mapWorkspaceStatus(status)
      return { ...mapped, terminalCount }
    }),



  /** Create workspace - unified API for all workspace creation scenarios */
  createWorkspace: publicProcedure
    .input(
      z.object({
        name: z.string(),
        workDir: z.string(),
        projectId: projectIdSchema.optional(),
        projectPath: z.string().optional(), // If provided and projectId is not, auto-create project
        projectName: z.string().optional(),
        collaborationMode: z.enum(["supervisor", "group"]).optional(),
      }),
    )
    .mutation(async ({ input }): Promise<Workspace> => {
      const collaborationMode = input.collaborationMode ?? "supervisor"

      // Create workspace
      let workspace = await ergataiFetch<BackendManagedWorkspace>(
        "/api/v1/workspaces/managed",
        {
          method: "POST",
          body: JSON.stringify({
            name: input.name,
            work_dir: input.workDir,
            collaboration_mode: collaborationMode,
          }),
        },
      )

      // If projectId is provided, set it as default project
      let didUpdateDefaultProject = false
      if (input.projectId) {
        await ergataiFetch<BackendManagedWorkspace>(
          `/api/v1/workspaces/managed/${encodeURIComponent(workspace.workspace_id)}`,
          {
            method: "PATCH",
            body: JSON.stringify({
              default_project_id: input.projectId,
            }),
          },
        )
        didUpdateDefaultProject = true
      } else if (input.projectPath) {
        // Auto-create project if projectPath is provided
        const project = await ergataiFetch<BackendWorkspaceProject>(
          `/api/v1/workspaces/managed/${encodeURIComponent(workspace.workspace_id)}/projects`,
          {
            method: "POST",
            body: JSON.stringify({
              name: input.projectName || input.name,
              path: input.projectPath,
            }),
          },
        )

        // Validate project_id format before using it
        if (!project.project_id || project.project_id.startsWith('ws_')) {
          console.error('[createWorkspace] Invalid project_id format:', project)
          throw new Error(`Project creation returned invalid project_id: ${project.project_id}`)
        }

        // Set as default project
        await ergataiFetch<BackendManagedWorkspace>(
          `/api/v1/workspaces/managed/${encodeURIComponent(workspace.workspace_id)}`,
          {
            method: "PATCH",
            body: JSON.stringify({
              default_project_id: project.project_id,
            }),
          },
        )
        didUpdateDefaultProject = true
      }

      // Re-fetch workspace once after unknown default-project update to get the
      // latest defaultProjectId. Previously this was duplicated in both branches.
      if (didUpdateDefaultProject) {
        workspace = await ergataiFetch<BackendManagedWorkspace>(
          `/api/v1/workspaces/managed/${encodeURIComponent(workspace.workspace_id)}`,
          { method: "GET" },
        )
      }

      return mapManagedWorkspace(workspace)
    }),



  // ── Chat Related (3 endpoints) ─────────────────────────────────────────

  /** Lookup worktree for chat */
  lookupChatWorktree: publicProcedure
    .input(z.object({ chatId: chatIdSchema }))
    .query(async ({ input }) => {
      if (!isValidChatId(input.chatId, "lookupChatWorktree")) {
        return null
      }

      return ergataiFetch(`/api/v1/chats/lookup-worktree?chat_id=${encodeURIComponent(input.chatId)}`)
    }),


})
