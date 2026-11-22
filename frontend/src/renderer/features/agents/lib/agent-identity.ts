/**
 * Identity helpers shared by custom agent profiles and bundled runtimes.
 *
 * Kept separate from the large contract module so every UI surface can resolve
 * a profile to its runtime without pulling provider/runtime code.
 */

export interface AgentIdentityRegistration {
  id: string
  profileName?: string
  name: string
  runtimeId: string
}

const CORE_RUNTIME_DISPLAY_NAMES: Record<string, string> = {
  claude: "Claude Code",
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
}

function displayNameForRuntime(runtimeId: string): string | undefined {
  return CORE_RUNTIME_DISPLAY_NAMES[runtimeId.trim().toLowerCase()]
}

/**
 * Resolve the backend profile name for a registration.
 *
 * Newer registrations store it explicitly. Older persisted registrations only
 * have a display name; built-ins use the runtime id, while custom agents are
 * registered under their display name.
 */
export function getAgentProfileName(agent: AgentIdentityRegistration): string {
  if (agent.profileName?.trim()) return agent.profileName.trim()
  if (agent.name === agent.runtimeId) return agent.runtimeId
  const runtimeDisplayName = displayNameForRuntime(agent.runtimeId)
  if (runtimeDisplayName === agent.name) return agent.runtimeId
  return agent.name
}

/**
 * Resolve the runtime id (e.g. "opencode") from any identifier belonging to a
 * registration. This lets custom profiles keep the runtime's built-in logo
 * when the user has not uploaded a photo.
 */
export function resolveAgentRuntimeId(
  registrations: AgentIdentityRegistration[],
  ...identifiers: Array<string | null | undefined>
): string | null {
  const keys = new Set(
    identifiers
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  )
  if (keys.size === 0) return null

  const match = registrations.find((agent) => {
    const candidates = [agent.id, agent.runtimeId, agent.profileName, agent.name]
    return candidates.some((candidate) => {
      const trimmed = candidate?.trim().toLowerCase()
      return !!trimmed && keys.has(trimmed)
    })
  })
  return match?.runtimeId ?? null
}

/**
 * Infer the built-in runtime from an agent command. Custom profiles share the
 * runtime command (e.g. "agentcode" -> "opencode acp"), so the command is the
 * most reliable signal when a registration is not available.
 */
export function resolveRuntimeAgentIdFromCommand(
  command: string | null | undefined,
): string | null {
  const haystack = command?.toLowerCase() ?? ""
  if (!haystack) return null
  if (haystack.includes("opencode")) return "opencode"
  if (haystack.includes("codex")) return "codex"
  if (haystack.includes("claude")) return "claude-code"
  return null
}
