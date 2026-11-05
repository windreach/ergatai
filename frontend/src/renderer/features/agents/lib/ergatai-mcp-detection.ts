/**
 * Shared detection helpers for Ergatai MCP tool calls.
 *
 * Different agents (Claude Code, Codex, OpenCode, ...) normalise the Ergatai
 * MCP server name in different ways ("Ergatai MCP Tools", "Ergatai_MCP_Tools",
 * "ergatai", "ergatai-mcp", ...). Relying on the exact server name is
 * therefore fragile. These helpers identify Ergatai MCP calls primarily by
 * their *structural* contract (e.g. send_message carries target_agent_id +
 * message) and fall back to case-insensitive name matching, so recognition
 * stays robust across agents.
 */

type AnyRecord = Record<string, unknown>

function asRecord(value: unknown): AnyRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as AnyRecord)
    : null
}

export function getPartType(part: unknown): string {
  const p = asRecord(part)
  if (!p) return ""
  return typeof p.type === "string" ? p.type : ""
}

export function getPartInput(part: unknown): AnyRecord | null {
  const p = asRecord(part)
  if (!p) return null
  const input = asRecord(p.input)
  if (input) return input
  // Some agents nest the real args under .args
  const args = asRecord(p.args)
  if (args) return args
  // input may be a JSON string
  if (typeof p.input === "string") {
    try {
      const parsed = JSON.parse(p.input)
      const rec = asRecord(parsed)
      if (rec) return rec
    } catch {
      // ignore
    }
  }
  return null
}

export function getPartToolName(part: unknown): string {
  const p = asRecord(part)
  if (!p) return ""
  if (typeof p.toolName === "string" && p.toolName.length > 0) return p.toolName
  const input = getPartInput(part)
  if (input && typeof input.toolName === "string") return input.toolName
  const type = getPartType(part)
  if (type.startsWith("tool-")) return type.slice("tool-".length)
  return ""
}

/**
 * Detect whether a tool-call part is an Ergatai `send_message` MCP call.
 *
 * Detection order (most → least reliable):
 *   1. Structural contract: input has target_agent_id (string) AND message (string).
 *   2. toolKind === "inter_agent_send".
 *   3. Tool name (from type/toolName/input.toolName) contains "send_message"
 *      or "sendmessage" (case-insensitive) — covers any server-name variant.
 *   4. Type ends with "__send_message" or equals a known legacy adapter name.
 */
export function isErgataiSendMessagePart(part: unknown): boolean {
  const p = asRecord(part)
  if (!p) return false

  // 1. Structural contract
  const input = getPartInput(part)
  if (
    input &&
    typeof input.target_agent_id === "string" &&
    input.target_agent_id.length > 0 &&
    typeof input.message === "string"
  ) {
    return true
  }

  // 2. Explicit tool kind
  if (p.toolKind === "inter_agent_send") return true

  // 3 & 4. Name-based (case-insensitive, server-name agnostic)
  const candidates = [getPartType(part), getPartToolName(part)]
  for (const candidate of candidates) {
    if (!candidate) continue
    const lower = candidate.toLowerCase()
    // Covers: send_message, sendmessage, __send_message, Ergatai_MCP_Tools_send_message
    if (lower.includes("send_message") || lower.includes("sendmessage")) {
      return true
    }
  }

  return false
}