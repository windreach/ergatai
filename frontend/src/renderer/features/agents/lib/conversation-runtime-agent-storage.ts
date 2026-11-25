/**
 * localStorage-backed mapping from conversationId -> runtime agent id.
 *
 * The agent id used to run a conversation is resolved lazily by the chat
 * transport (getOrCreateActiveAgent / promptAgent).  Persisting it here lets
 * other surfaces (e.g. the Stop button) target the exact agent that is
 * currently streaming for that conversation instead of guessing from the
 * chat-level agent binding list.
 */
const STORAGE_KEY = "ergatai_conversation_runtime_agents"

export const conversationRuntimeAgentStorage = {
  get(conversationId: string): string | null {
    if (typeof window === "undefined") return null
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (!stored) return null
      const map = JSON.parse(stored)
      return (map && map[conversationId]) || null
    } catch {
      return null
    }
  },

  set(conversationId: string, agentId: string): boolean {
    if (!conversationId || !agentId) return false
    if (typeof window === "undefined") return false
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      const map = stored ? JSON.parse(stored) : {}
      map[conversationId] = agentId
      localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
      return true
    } catch (error) {
      console.error("[conversationRuntimeAgentStorage] Failed to save agent id:", error)
      return false
    }
  },

  delete(conversationId: string): void {
    if (typeof window === "undefined") return
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (!stored) return
      const map = JSON.parse(stored)
      delete map[conversationId]
      localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
    } catch (error) {
      console.warn("[conversationRuntimeAgentStorage] Failed to delete agent id:", error)
    }
  },
}