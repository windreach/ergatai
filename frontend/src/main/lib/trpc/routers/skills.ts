import { z } from "zod"
import { router, publicProcedure } from "../index"

// Skills file reading removed - each agent has different skill formats
// UI commands /skills and /mcp are kept but return empty lists

export interface Skill {
  name: string
  description: string
  path: string
  source: "user" | "project" | "plugin"
}

export const skillsRouter = router({
  /**
   * List skills - returns empty array
   * File reading removed: each agent (Claude, Codex, etc.) has different skill formats
   */
  list: publicProcedure
    .input(
      z
        .object({
          cwd: z.string().optional(),
        })
        .optional(),
    )
    .query(async (): Promise<Skill[]> => {
      return []
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
    .query(async (): Promise<Skill[]> => {
      return []
    }),
})
