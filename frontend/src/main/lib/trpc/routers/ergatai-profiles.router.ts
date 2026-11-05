import {
  AgentProfileSchema,
  AgentProfileWithStatusSchema,
  ergataiFetch,
  publicProcedure,
  router,
  z,
} from "./ergatai-shared"

export const profilesRouter = router({

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
