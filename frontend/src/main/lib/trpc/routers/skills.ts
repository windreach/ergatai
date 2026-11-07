import { z } from "zod"
import { router, publicProcedure } from "../index"
import { ergataiFetch } from "../../ergatai/api"

export interface Skill {
  name: string
  description: string
  path: string
  source: "user" | "project" | "plugin"
}

export const skillsRouter = router({
  /**
   * List skills discovered by the backend from known agent directories.
   */
  list: publicProcedure
    .input(
      z
        .object({
          cwd: z.string().optional(),
        })
        .optional(),
    )
    .query(async ({ input }): Promise<Skill[]> => {
      const response = await ergataiFetch<{ skills: Skill[] }>(
        `/api/v1/skills${input?.cwd ? `?cwd=${encodeURIComponent(input.cwd)}` : ""}`,
      )
      return response.skills || []
    }),

  /**
   * Alias for list - used by @ mention
   */
  listEnabled: publicProcedure
    .input(
      z
        .object({
          cwd: z.string().optional(),
        })
        .optional(),
    )
    .query(async ({ input }): Promise<Skill[]> => {
      const response = await ergataiFetch<{ skills: Skill[] }>(
        `/api/v1/skills${input?.cwd ? `?cwd=${encodeURIComponent(input.cwd)}` : ""}`,
      )
      return response.skills || []
    }),
})
