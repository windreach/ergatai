import {
  AgentProfileSchema,
  AgentProfileWithStatusSchema,
  ergataiFetch,
  publicProcedure,
  router,
  z,
} from "./ergatai-shared"

export const profilesRouter = router({
  /** List shared provider connections */
  listProviderConnections: publicProcedure.query(async () => {
    return ergataiFetch<
      Array<{
        id: string
        name: string
        /** Owning agent profile name. A connection belongs to exactly one agent. */
        agentId: string
        protocol: "anthropic" | "openai_compatible" | "opencode"
        baseUrl?: string | null
        authRef?: string | null
        defaultModel?: string | null
        isDefault: boolean
        createdAt: number
        updatedAt: number
      }>
    >("/api/v1/provider-connections")
  }),

  /** Create or update a shared provider connection */
  saveProviderConnection: publicProcedure
    .input(
      z.object({
        id: z.string().optional(),
        name: z.string().min(1),
        agent_id: z.string().min(1),
        protocol: z.enum(["anthropic", "openai_compatible", "opencode"]),
        base_url: z.string().optional(),
        default_model: z.string().optional(),
        is_default: z.boolean().default(false),
        api_key: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      return ergataiFetch<{ connection: { id: string; name: string } }>(
        "/api/v1/provider-connections",
        {
          method: "POST",
          body: JSON.stringify({
            id: input.id,
            name: input.name,
            agent_id: input.agent_id,
            protocol: input.protocol,
            base_url: input.base_url,
            default_model: input.default_model,
            is_default: input.is_default,
            api_key: input.api_key,
          }),
        },
      )
    }),

  /** Mark a shared provider connection as default */
  setDefaultProviderConnection: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      return ergataiFetch<{ connection: { id: string } }>(
        `/api/v1/provider-connections/${encodeURIComponent(input.id)}/default`,
        { method: "POST" },
      )
    }),

  /** Delete a shared provider connection and its OS credential-store entry */
  deleteProviderConnection: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      return ergataiFetch<{ deleted: boolean }>(
        `/api/v1/provider-connections/${encodeURIComponent(input.id)}`,
        { method: "DELETE" },
      )
    }),

  /**
   * Detect the agent's own default configuration (e.g.
   * ~/.claude/settings.json, ~/.codex/config.toml). Returns null when none is
   * found. The API key is never returned — only whether one exists.
   */
  detectNativeConnection: publicProcedure
    .input(z.object({ agentId: z.string().min(1) }))
    .query(async ({ input }) => {
      return ergataiFetch<{
        agentId: string
        protocol: string
        sourcePath: string
        baseUrl?: string | null
        defaultModel?: string | null
        hasApiKey: boolean
      } | null>(
        `/api/v1/provider-connections/native?agent_id=${encodeURIComponent(input.agentId)}`,
      )
    }),

  /** Import the agent's native default configuration as its owned connection. */
  importNativeConnection: publicProcedure
    .input(z.object({ agentId: z.string().min(1) }))
    .mutation(async ({ input }) => {
      return ergataiFetch<{ connection: { id: string; name: string } }>(
        "/api/v1/provider-connections/import-native",
        {
          method: "POST",
          body: JSON.stringify({ agent_id: input.agentId }),
        },
      )
    }),


  /** List agent profiles (templates) */
  listProfiles: publicProcedure.query(async () => {
    return ergataiFetch<{ profiles: z.infer<typeof AgentProfileSchema>[] }>("/api/v1/agent-profiles")
  }),



  /** List agent profiles with installation status */
  listProfilesWithStatus: publicProcedure.query(async () => {
    return ergataiFetch<{ profiles: z.infer<typeof AgentProfileWithStatusSchema>[] }>(
      "/api/v1/agent-profiles/with-status",
    )
  }),



  /** Install an agent by profile name (npm install -g) */
  installAgent: publicProcedure
    .input(z.object({ name: z.string() }))
    .mutation(async ({ input }) => {
      return ergataiFetch<{ status: string; message: string; output: string }>(
        `/api/v1/agent-profiles/${encodeURIComponent(input.name)}/install`,
        { method: "POST" },
      )
    }),



  /** Uninstall an agent by profile name (npm uninstall -g) */
  uninstallAgent: publicProcedure
    .input(z.object({ name: z.string() }))
    .mutation(async ({ input }) => {
      return ergataiFetch<{ status: string; message: string; output: string }>(
        `/api/v1/agent-profiles/${encodeURIComponent(input.name)}/uninstall`,
        { method: "DELETE" },
      )
    }),



  /** Register a new agent profile */
  registerProfile: publicProcedure
    .input(
      z.object({
        name: z.string(),
        command: z.string(),
        agentType: z.string(),
        packageName: z.string().optional(),
        avatarUrl: z.string().optional(),
        nativeTriggers: z.array(z.record(z.string(), z.unknown())).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      return ergataiFetch<{ id: string; name: string }>("/api/v1/agent-profiles", {
        method: "POST",
        body: JSON.stringify({
          name: input.name,
          command: input.command,
          agent_type: input.agentType,
          package_name: input.packageName ?? null,
          avatar_url: input.avatarUrl ?? null,
          native_triggers: input.nativeTriggers ?? null,
        }),
      })
    }),



  /** Delete an agent profile by ID */
  deleteProfile: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      return ergataiFetch<{ status: string; message: string }>(
        `/api/v1/agent-profiles/${encodeURIComponent(input.id)}`,
        { method: "DELETE" },
      )
    }),


})
