/**
 * Simple localStorage-based storage for conversation agent commands.
 * Maps conversationId -> agent command (e.g., "claude-code", "mock-agent")
 */

const STORAGE_KEY = "ergatai_conversation_agents"

export const conversationAgentStorage = {
  get(conversationId: string): string | null {
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (!stored) return null
      const map = JSON.parse(stored)
      return map[conversationId] || null
    } catch {
      return null
    }
  },

  set(conversationId: string, agentCommand: string): boolean {
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      const map = stored ? JSON.parse(stored) : {}
      map[conversationId] = agentCommand
      localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
      return true
    } catch (error) {
      console.error("[conversationAgentStorage] Failed to save agent command:", error)
      return false
    }
  },

  delete(conversationId: string): void {
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (!stored) return
      const map = JSON.parse(stored)
      delete map[conversationId]
      localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
    } catch (error) {
      console.warn("[conversationAgentStorage] Failed to delete agent command:", error)
    }
  },
}
