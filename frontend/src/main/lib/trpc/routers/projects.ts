import { z } from "zod"
import { router, publicProcedure } from "../index"
import { dialog, BrowserWindow, app } from "electron"
import { basename, join } from "path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { existsSync } from "node:fs"
import { mkdir, copyFile, unlink } from "node:fs/promises"
import { extname } from "node:path"
import { getGitRemoteInfo } from "../../git"
import { trackProjectOpened } from "../../analytics"
import { getLaunchDirectory } from "../../cli"
import { ergataiCaller as trpcClient } from "../../ergatai/caller"
import { projectIdSchema } from "../../validation/ids"

const execFileAsync = promisify(execFile)

export const projectsRouter = router({
  /**
   * Get launch directory from CLI args (consumed once)
   * Based on PR #16 by @caffeinum
   */
  getLaunchDirectory: publicProcedure.query(() => {
    return getLaunchDirectory()
  }),

  /**
   * List all projects
   */
  list: publicProcedure.query(async () => {
    return await trpcClient.listProjects()
  }),

  /**
   * Get a single project by ID
   */
  get: publicProcedure
    .input(z.object({ id: projectIdSchema }))
    .query(async ({ input }) => {
      return await trpcClient.getProject({ id: input.id })
    }),

  /**
   * Open folder picker and create project
   */
  openFolder: publicProcedure.mutation(async ({ ctx }) => {
    const window = ctx.getWindow?.() ?? BrowserWindow.getFocusedWindow()

    if (!window) {
      console.error("[Projects] No window available for folder dialog")
      return null
    }

    // Ensure window is focused before showing dialog (fixes first-launch timing issue on macOS)
    if (!window.isFocused()) {
      console.log("[Projects] Window not focused, focusing before dialog...")
      window.focus()
      // Small delay to ensure focus is applied by the OS
      await new Promise((resolve) => setTimeout(resolve, 100))
    }

    const result = await dialog.showOpenDialog(window, {
      properties: ["openDirectory", "createDirectory"],
      title: "Select Project Folder",
      buttonLabel: "Open Project",
    })

    if (result.canceled || result.filePaths.length === 0) {
      return null
    }

    const folderPath = result.filePaths[0]!
    const folderName = basename(folderPath)

    // Get git remote info
    const gitInfo = await getGitRemoteInfo(folderPath)

    // Check if project already exists by listing all projects
    const allProjects = await trpcClient.listProjects()
    const existing = allProjects.find((p: any) => p.path === folderPath)

    if (existing) {
      // Update the project with new git info
      const updatedProject = await trpcClient.updateProject({
        id: existing.id,
        gitRemoteUrl: gitInfo.remoteUrl,
        gitProvider: gitInfo.provider,
        gitOwner: gitInfo.owner,
        gitRepo: gitInfo.repo,
      })

      if (!updatedProject) {
        throw new Error("Failed to update project")
      }

      // Track project opened
      trackProjectOpened({
        id: updatedProject.id,
        hasGitRemote: !!gitInfo.remoteUrl,
      })

      return updatedProject
    }

    // Create new project with git info
    const newProject = await trpcClient.createProject({
      name: folderName,
      path: folderPath,
      gitRemoteUrl: gitInfo.remoteUrl,
      gitProvider: gitInfo.provider,
      gitOwner: gitInfo.owner,
      gitRepo: gitInfo.repo,
    })

    // Track project opened
    trackProjectOpened({
      id: newProject.id,
      hasGitRemote: !!gitInfo.remoteUrl,
    })

    return newProject
  }),

  /**
   * Pick a folder using native dialog, returns the path (no project creation)
   */
  pickFolder: publicProcedure.mutation(async ({ ctx }) => {
    const window = ctx.getWindow?.() ?? BrowserWindow.getFocusedWindow()

    if (!window) {
      console.error("[Projects] No window available for folder dialog")
      return null
    }

    if (!window.isFocused()) {
      window.focus()
      await new Promise((resolve) => setTimeout(resolve, 100))
    }

    const result = await dialog.showOpenDialog(window, {
      properties: ["openDirectory", "createDirectory"],
      title: "Select Folder",
      buttonLabel: "Select",
    })

    if (result.canceled || result.filePaths.length === 0) {
      return null
    }

    return result.filePaths[0]!
  }),

  /**
   * Create a project from a known path
   */
  create: publicProcedure
    .input(z.object({ path: z.string(), name: z.string().optional() }))
    .mutation(async ({ input }) => {
      const name = input.name || basename(input.path)

      // Check if project already exists
      const allProjects = await trpcClient.listProjects()
      const existing = allProjects.find((p: any) => p.path === input.path)

      if (existing) {
        return existing
      }

      // Get git remote info
      const gitInfo = await getGitRemoteInfo(input.path)

      return await trpcClient.createProject({
        name,
        path: input.path,
        gitRemoteUrl: gitInfo.remoteUrl,
        gitProvider: gitInfo.provider,
        gitOwner: gitInfo.owner,
        gitRepo: gitInfo.repo,
      })
    }),

  /**
   * Rename a project
   */
  rename: publicProcedure
    .input(z.object({ id: projectIdSchema, name: z.string().min(1) }))
    .mutation(async ({ input }) => {
      return await trpcClient.updateProject({
        id: input.id,
        name: input.name,
      })
    }),

  /**
   * Delete a project and all its chats
   */
  delete: publicProcedure
    .input(z.object({ id: projectIdSchema }))
    .mutation(async ({ input }) => {
      await trpcClient.deleteProject({ id: input.id })
      return { success: true }
    }),

  /**
   * Refresh git info for a project (in case remote changed)
   */
  refreshGitInfo: publicProcedure
    .input(z.object({ id: projectIdSchema }))
    .mutation(async ({ input }) => {
      // Get project
      const project = await trpcClient.getProject({ id: input.id })

      if (!project) {
        return null
      }

      // Get fresh git info
      const gitInfo = await getGitRemoteInfo(project.path)

      // Update project
      return await trpcClient.updateProject({
        id: input.id,
        gitRemoteUrl: gitInfo.remoteUrl,
        gitProvider: gitInfo.provider,
        gitOwner: gitInfo.owner,
        gitRepo: gitInfo.repo,
      })
    }),

  /**
   * Clone a GitHub repo and create a project
   */
  cloneFromGitHub: publicProcedure
    .input(z.object({ repoUrl: z.string() }))
    .mutation(async ({ input }) => {
      const { repoUrl } = input

      // Parse the URL to extract owner/repo
      let owner: string | null = null
      let repo: string | null = null

      // Match HTTPS format: https://github.com/owner/repo
      const httpsMatch = repoUrl.match(
        /https?:\/\/github\.com\/([^/]+)\/([^/]+)/,
      )
      if (httpsMatch) {
        owner = httpsMatch[1] || null
        repo = httpsMatch[2]?.replace(/\.git$/, "") || null
      }

      // Match SSH format: git@github.com:owner/repo
      const sshMatch = repoUrl.match(/git@github\.com:([^/]+)\/(.+)/)
      if (sshMatch) {
        owner = sshMatch[1] || null
        repo = sshMatch[2]?.replace(/\.git$/, "") || null
      }

      // Match short format: owner/repo
      const shortMatch = repoUrl.match(/^([^/]+)\/([^/]+)$/)
      if (shortMatch) {
        owner = shortMatch[1] || null
        repo = shortMatch[2]?.replace(/\.git$/, "") || null
      }

      if (!owner || !repo) {
        throw new Error("Invalid GitHub URL or repo format")
      }

      // SECURITY: Validate owner/repo don't contain path traversal or shell metacharacters
      if (/[\\/]/.test(owner) || /[\\/]/.test(repo) || owner.includes("..") || repo.includes("..")) {
        throw new Error("Invalid characters in owner or repo name")
      }

      // Clone to ~/.ergatai/repos/{owner}/{repo}; keep existing ~/.21st repos usable.
      const homePath = app.getPath("home")
      const reposDir = join(homePath, ".ergatai", "repos")
      const ergataiClonePath = join(homePath, ".ergatai", "repos", owner, repo)
      const legacyClonePath = join(homePath, ".21st", "repos", owner, repo)
      const clonePath = existsSync(ergataiClonePath)
        ? ergataiClonePath
        : existsSync(legacyClonePath)
          ? legacyClonePath
          : ergataiClonePath

      // Check if already cloned
      if (existsSync(clonePath)) {
        // Project might already exist in DB
        const allProjects = await trpcClient.listProjects()
        const existing = allProjects.find((p: any) => p.path === clonePath)

        if (existing) {
          trackProjectOpened({
            id: existing.id,
            hasGitRemote: !!existing.gitRemoteUrl,
          })
          return existing
        }

        // Create project for existing clone
        const gitInfo = await getGitRemoteInfo(clonePath)
        const newProject = await trpcClient.createProject({
          name: repo,
          path: clonePath,
          gitRemoteUrl: gitInfo.remoteUrl,
          gitProvider: gitInfo.provider,
          gitOwner: gitInfo.owner,
          gitRepo: gitInfo.repo,
        })

        trackProjectOpened({
          id: newProject.id,
          hasGitRemote: !!gitInfo.remoteUrl,
        })
        return newProject
      }

      // Create repos directory
      await mkdir(reposDir, { recursive: true })

      // Clone the repo (use execFile to avoid shell injection)
      const cloneUrl = `https://github.com/${owner}/${repo}.git`
      await execFileAsync("git", ["clone", cloneUrl, clonePath])

      // Get git info and create project
      const gitInfo = await getGitRemoteInfo(clonePath)

      const newProject = await trpcClient.createProject({
        name: repo,
        path: clonePath,
        gitRemoteUrl: gitInfo.remoteUrl,
        gitProvider: gitInfo.provider,
        gitOwner: gitInfo.owner,
        gitRepo: gitInfo.repo,
      })

      trackProjectOpened({
        id: newProject.id,
        hasGitRemote: !!gitInfo.remoteUrl,
      })

      return newProject
    }),

  /**
   * Open folder picker to locate an existing clone of a specific repo
   * Validates that the selected folder matches the expected owner/repo
   */
  locateAndAddProject: publicProcedure
    .input(
      z.object({
        expectedOwner: z.string(),
        expectedRepo: z.string(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const window = ctx.getWindow?.() ?? BrowserWindow.getFocusedWindow()

      if (!window) {
        return { success: false as const, reason: "no-window" as const }
      }

      // Ensure window is focused
      if (!window.isFocused()) {
        window.focus()
        await new Promise((resolve) => setTimeout(resolve, 100))
      }

      const result = await dialog.showOpenDialog(window, {
        properties: ["openDirectory"],
        title: `Locate ${input.expectedOwner}/${input.expectedRepo}`,
        buttonLabel: "Select",
      })

      if (result.canceled || !result.filePaths[0]) {
        return { success: false as const, reason: "canceled" as const }
      }

      const folderPath = result.filePaths[0]
      const gitInfo = await getGitRemoteInfo(folderPath)

      // Validate it's the correct repo
      if (
        gitInfo.owner !== input.expectedOwner ||
        gitInfo.repo !== input.expectedRepo
      ) {
        return {
          success: false as const,
          reason: "wrong-repo" as const,
          found:
            gitInfo.owner && gitInfo.repo
              ? `${gitInfo.owner}/${gitInfo.repo}`
              : "not a git repository",
        }
      }

      // Create or update project
      const allProjects = await trpcClient.listProjects()
      const existing = allProjects.find((p: any) => p.path === folderPath)

      if (existing) {
        // Update git info in case it changed
        const updated = await trpcClient.updateProject({
          id: existing.id,
          gitRemoteUrl: gitInfo.remoteUrl,
          gitProvider: gitInfo.provider,
          gitOwner: gitInfo.owner,
          gitRepo: gitInfo.repo,
        })

        return { success: true as const, project: updated }
      }

      const project = await trpcClient.createProject({
        name: basename(folderPath),
        path: folderPath,
        gitRemoteUrl: gitInfo.remoteUrl,
        gitProvider: gitInfo.provider,
        gitOwner: gitInfo.owner,
        gitRepo: gitInfo.repo,
      })

      return { success: true as const, project }
    }),

  /**
   * Open folder picker to choose where to clone a repository
   */
  pickCloneDestination: publicProcedure
    .input(z.object({ suggestedName: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const window = ctx.getWindow?.() ?? BrowserWindow.getFocusedWindow()

      if (!window) {
        return { success: false as const, reason: "no-window" as const }
      }

      // Ensure window is focused
      if (!window.isFocused()) {
        window.focus()
        await new Promise((resolve) => setTimeout(resolve, 100))
      }

      // Default to ~/.ergatai/repos/
      const homePath = app.getPath("home")
      const defaultPath = join(homePath, ".ergatai", "repos")
      await mkdir(defaultPath, { recursive: true })

      const result = await dialog.showOpenDialog(window, {
        properties: ["openDirectory", "createDirectory"],
        title: "Choose where to clone",
        defaultPath,
        buttonLabel: "Clone Here",
      })

      if (result.canceled || !result.filePaths[0]) {
        return { success: false as const, reason: "canceled" as const }
      }

      const targetPath = join(result.filePaths[0], input.suggestedName)
      return { success: true as const, targetPath }
    }),

  /**
   * Upload a custom icon for a project (opens file picker for images)
   */
  uploadIcon: publicProcedure
    .input(z.object({ id: projectIdSchema }))
    .mutation(async ({ input, ctx }) => {
      const window = ctx.getWindow?.() ?? BrowserWindow.getFocusedWindow()
      if (!window) return null

      if (!window.isFocused()) {
        window.focus()
        await new Promise((resolve) => setTimeout(resolve, 100))
      }

      const result = await dialog.showOpenDialog(window, {
        properties: ["openFile"],
        title: "Select Project Icon",
        buttonLabel: "Set Icon",
        filters: [
          { name: "Images", extensions: ["png", "jpg", "jpeg", "svg", "webp", "ico"] },
        ],
      })

      if (result.canceled || !result.filePaths[0]) return null

      const sourcePath = result.filePaths[0]
      const ext = extname(sourcePath)
      const iconsDir = join(app.getPath("userData"), "project-icons")
      await mkdir(iconsDir, { recursive: true })

      const destPath = join(iconsDir, `${input.id}${ext}`)
      await copyFile(sourcePath, destPath)

      return await trpcClient.updateProject({
        id: input.id,
        iconPath: destPath,
      })
    }),

  /**
   * Remove custom icon for a project
   */
  removeIcon: publicProcedure
    .input(z.object({ id: projectIdSchema }))
    .mutation(async ({ input }) => {
      const project = await trpcClient.getProject({ id: input.id })

      if (project?.iconPath && existsSync(project.iconPath)) {
        try { await unlink(project.iconPath) } catch {}
      }

      return await trpcClient.updateProject({
        id: input.id,
        iconPath: null,
      })
    }),
})
