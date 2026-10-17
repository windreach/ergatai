import { router, publicProcedure } from "../index"
import { app, shell } from "electron"
import { getAuthManager } from "../../../index"
import { z } from "zod"
import { clearNetworkCache } from "../../ollama/network-detector"
import {
  deleteChat,
  deleteProject,
  listChats,
  listProjects,
  listConversations,
} from "../../ergatai/user-data"

// Protocol constant (must match main/index.ts)
const IS_DEV = !!process.env.ELECTRON_RENDERER_URL
const PROTOCOL = IS_DEV ? "ergatai-dev" : "ergatai"

// Global flag for simulating offline mode (for testing)
let simulateOfflineMode = false

/**
 * Check if offline mode is being simulated (for testing)
 * Used by network-detector.ts
 */
export function isOfflineSimulated(): boolean {
  return simulateOfflineMode
}

export const debugRouter = router({
  /**
   * Get system information for debug display
   */
  getSystemInfo: publicProcedure.query(() => {
    // Check protocol registration
    let protocolRegistered = false
    try {
      protocolRegistered = process.defaultApp
        ? app.isDefaultProtocolClient(
            PROTOCOL,
            process.execPath,
            [process.argv[1]!],
          )
        : app.isDefaultProtocolClient(PROTOCOL)
    } catch {
      protocolRegistered = false
    }

    return {
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      isDev: IS_DEV,
      userDataPath: app.getPath("userData"),
      protocolRegistered,
    }
  }),

  /**
   * Get database statistics
   */
  getDbStats: publicProcedure.query(async () => {
    const projects = await listProjects()
    const chats = await listChats()
    const conversationLists = await Promise.all(chats.map((chat) => listConversations(chat.id)))
    const conversationCount = conversationLists.reduce((total, conversations) => total + conversations.length, 0)

    return {
      projects: projects.length,
      chats: chats.length,
      conversations: conversationCount,
    }
  }),

  /**
   * Clear all chats and conversations (keeps projects)
   */
  clearChats: publicProcedure.mutation(async () => {
    const chats = await listChats()
    await Promise.all(chats.map((chat) => deleteChat(chat.id)))
    console.log("[Debug] Cleared all chats and conversations")
    return { success: true }
  }),

  /**
   * Clear all data (projects, chats, conversations)
   */
  clearAllData: publicProcedure.mutation(async () => {
    const chats = await listChats()
    for (const chat of chats) {
      await deleteChat(chat.id)
    }

    const projects = await listProjects()
    for (const project of projects) {
      await deleteProject(project.id)
    }
    console.log("[Debug] Cleared all database data")
    return { success: true }
  }),

  /**
   * Logout (clear auth only)
   */
  logout: publicProcedure.mutation(() => {
    const authManager = getAuthManager()
    authManager.logout()
    console.log("[Debug] User logged out")
    return { success: true }
  }),

  /**
   * Open userData folder in system file manager
   */
  openUserDataFolder: publicProcedure.mutation(() => {
    const userDataPath = app.getPath("userData")
    shell.openPath(userDataPath)
    console.log("[Debug] Opened userData folder:", userDataPath)
    return { success: true }
  }),

  /**
   * Get offline simulation status
   */
  getOfflineSimulation: publicProcedure.query(() => {
    return { enabled: simulateOfflineMode }
  }),

  /**
   * Set offline simulation status (for testing)
   */
  setOfflineSimulation: publicProcedure
    .input(z.object({ enabled: z.boolean() }))
    .mutation(({ input }) => {
      simulateOfflineMode = input.enabled
      // Clear network cache to force immediate re-check
      clearNetworkCache()
      console.log(`[Debug] Offline simulation ${input.enabled ? "enabled" : "disabled"}`)
      return { success: true, enabled: simulateOfflineMode }
    }),
})
