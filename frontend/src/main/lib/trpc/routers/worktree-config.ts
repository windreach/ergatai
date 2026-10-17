import { z } from "zod"
import { router, publicProcedure } from "../index"
import { getProject } from "../../ergatai/user-data"
import {
  detectWorktreeConfig,
  saveWorktreeConfig,
  getAvailableConfigPaths,
  type WorktreeConfig,
} from "../../git/worktree-config"
import { projectIdSchema } from "../../validation/ids"

const WorktreeConfigSchema = z.object({
  "setup-worktree-unix": z.union([z.array(z.string()), z.string()]).optional(),
  "setup-worktree-windows": z.union([z.array(z.string()), z.string()]).optional(),
  "setup-worktree": z.union([z.array(z.string()), z.string()]).optional(),
})

export const worktreeConfigRouter = router({
  /**
   * Get worktree config for a project
   * Detects from .ergatai/worktree.json, .cursor/worktrees.json, or a legacy project path
   */
  get: publicProcedure
    .input(z.object({ projectId: projectIdSchema }))
    .query(async ({ input }) => {
      const project = await getProject(input.projectId)

      if (!project) {
        throw new Error("Project not found")
      }

      const detected = await detectWorktreeConfig(project.path)
      const available = await getAvailableConfigPaths(project.path)

      return {
        config: detected.config,
        path: detected.path,
        source: detected.source,
        available,
        projectPath: project.path,
      }
    }),

  /**
   * Save worktree config for a project
   */
  save: publicProcedure
    .input(
      z.object({
        projectId: projectIdSchema,
        config: WorktreeConfigSchema,
        target: z.enum(["cursor", "ergatai"]).or(z.string()).default("ergatai"),
      }),
    )
    .mutation(async ({ input }) => {
      const project = await getProject(input.projectId)

      if (!project) {
        throw new Error("Project not found")
      }

      const result = await saveWorktreeConfig(
        project.path,
        input.config as WorktreeConfig,
        input.target,
      )

      return result
    }),

  /**
   * Get available config paths for a project
   */
  getAvailablePaths: publicProcedure
    .input(z.object({ projectId: projectIdSchema }))
    .query(async ({ input }) => {
      const project = await getProject(input.projectId)

      if (!project) {
        throw new Error("Project not found")
      }

      return getAvailableConfigPaths(project.path)
    }),
})
