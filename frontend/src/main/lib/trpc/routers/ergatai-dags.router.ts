import {
  DagSubmitResponse,
  ergataiFetch,
  publicProcedure,
  router,
  z,
} from "./ergatai-shared"

export const dagsRouter = router({

  // ── DAG Endpoints (migrated to Collaboration Sessions) ─────────────────

  /** List all DAGs (now returns collaboration sessions) */
  listDags: publicProcedure.query(async () => {
    // DAG functionality has been migrated to collaboration sessions
    return ergataiFetch("/api/v1/collaboration-sessions")
  }),



  /** Get DAG status (now returns collaboration session detail) */
  getDagStatus: publicProcedure
    .input(z.object({ dagId: z.string() }))
    .query(async ({ input }) => {
      // Use collaboration session detail endpoint
      return ergataiFetch(`/api/v1/collaboration-sessions/${encodeURIComponent(input.dagId)}`)
    }),



  /** Get DAG metrics (now returns collaboration session progress) */
  getDagMetrics: publicProcedure
    .input(z.object({ dagId: z.string() }))
    .query(async ({ input }) => {
      // Use collaboration session progress endpoint
      return ergataiFetch(`/api/v1/collaboration-sessions/${encodeURIComponent(input.dagId)}/progress`)
    }),



  // ── DAG Submission & Validation Endpoints (migrated to Collaboration Sessions) ──

  /** Submit a DAG definition for orchestration (now creates collaboration session) */
  submitDag: publicProcedure
    .input(
      z.object({
        definition: z.string(),
        parameters: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .mutation(async ({ input }): Promise<DagSubmitResponse> => {
      // Use collaboration sessions endpoint
      return ergataiFetch<DagSubmitResponse>("/api/v1/collaboration-sessions", {
        method: "POST",
        body: JSON.stringify({
          definition: input.definition,
          parameters: input.parameters ?? undefined,
        }),
      })
    }),


})
