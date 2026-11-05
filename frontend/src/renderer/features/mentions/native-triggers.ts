/**
 * Agent-native trigger matching.
 *
 * This is a closed-world allowlist. Ergatai only opens UI for trigger entry
 * points explicitly supplied by ACP, an adapter, or an agent profile. Anything
 * else is ordinary text and must remain byte-for-byte passthrough.
 */

export type AgentTriggerExecution =
  | "host"
  | "acp"
  | "adapter"
  | "passthrough"
  | "unavailable"

export type AgentTriggerKind =
  | "route"
  | "context"
  | "command"
  | "keyword"

export type AgentTriggerSource =
  | "builtin"
  | "acp"
  | "adapter"
  | "manual"

export type AgentNativeTrigger = {
  id: string
  agentId?: string
  /** Exactly one character. Multi-character triggers are not supported. */
  char: string
  kind: AgentTriggerKind
  /** Regex evaluated against text before the caret. */
  pattern: string
  execution: AgentTriggerExecution
  source: AgentTriggerSource
  description?: string
}

export type AgentTriggerMatch = {
  trigger: AgentNativeTrigger
  /** Text matched at the caret, including the trigger character. */
  matchedText: string
  /** First useful capture, or the full match when the pattern has no capture. */
  query: string
}

const MAX_PATTERN_LENGTH = 512
const MAX_TRIGGERS = 64

function isTriggerExecution(value: unknown): value is AgentTriggerExecution {
  return (
    value === "host" ||
    value === "acp" ||
    value === "adapter" ||
    value === "passthrough" ||
    value === "unavailable"
  )
}

function isTriggerKind(value: unknown): value is AgentTriggerKind {
  return value === "route" || value === "context" || value === "command" || value === "keyword"
}

function isTriggerSource(value: unknown): value is AgentTriggerSource {
  return value === "builtin" || value === "acp" || value === "adapter" || value === "manual"
}

function resolveTriggerSource(value: unknown): AgentTriggerSource {
  if (value === null) return "adapter"
  return isTriggerSource(value) ? value : "manual"
}

function resolveAgentId(
  agentId: unknown,
  agent_id: unknown,
): string | undefined {
  if (typeof agentId === "string" && agentId) return agentId
  if (typeof agent_id === "string" && agent_id) return agent_id
  return undefined
}

function isSingleCharacter(value: unknown): value is string {
  return typeof value === "string" && [...value].length === 1
}

/**
 * Normalize untrusted backend/adapter metadata. Invalid entries are dropped:
 * a bad manifest must degrade to passthrough, never introduce a parser bug.
 */
export function normalizeAgentTriggers(input: unknown): AgentNativeTrigger[] {
  if (!Array.isArray(input)) return []

  const output: AgentNativeTrigger[] = []
  const seen = new Set<string>()

  for (const item of input.slice(0, MAX_TRIGGERS)) {
    if (typeof item !== "object" || item === null) continue
    const value = item as Record<string, unknown>
    const execution = value.execution
    const kind = value.kind
    const source = resolveTriggerSource(value.source)
    const pattern = value.pattern
    const char = value.char

    if (
      typeof value.id !== "string" ||
      value.id.trim().length === 0 ||
      !isSingleCharacter(char) ||
      !isTriggerKind(kind) ||
      !isTriggerExecution(execution) ||
      !isTriggerSource(source) ||
      typeof pattern !== "string" ||
      pattern.length === 0 ||
      pattern.length > MAX_PATTERN_LENGTH
    ) {
      continue
    }

    if (seen.has(value.id)) continue

    try {
      new RegExp(pattern, "u")
    } catch {
      continue
    }

    const normalized: AgentNativeTrigger = {
      id: value.id,
      agentId: resolveAgentId(value.agentId, value.agent_id),
      char,
      kind,
      pattern,
      execution,
      source,
      description: typeof value.description === "string" ? value.description : undefined,
    }
    seen.add(normalized.id)
    output.push(normalized)
  }

  return output
}

function extractQuery(match: RegExpExecArray): string {
  for (let index = match.length - 1; index >= 1; index -= 1) {
    const value = match[index]
    if (value !== undefined && value.length > 0) return value
  }
  return match[0]
}

/**
 * Return all explicitly registered native triggers matching immediately before
 * the caret. Patterns are anchored by requiring the match to end at the caret;
 * authors may additionally use `^` or `\\n` for line-start semantics.
 */
export function matchAgentTriggers(
  textBeforeCursor: string,
  triggers: readonly AgentNativeTrigger[],
): AgentTriggerMatch[] {
  const matches: AgentTriggerMatch[] = []
  const seen = new Set<string>()

  for (const trigger of triggers) {
    if (seen.has(trigger.id)) continue

    let regex: RegExp
    try {
      regex = new RegExp(trigger.pattern, "u")
    } catch {
      continue
    }

    const match = regex.exec(textBeforeCursor)
    if (!match) continue

    const matchEnd = match.index + match[0].length
    if (matchEnd !== textBeforeCursor.length) continue

    seen.add(trigger.id)
    matches.push({
      trigger,
      matchedText: match[0],
      query: extractQuery(match),
    })
  }

  // Stable order is important for grouped menus and deterministic keyboard UI.
  return matches.sort((a, b) => a.trigger.id.localeCompare(b.trigger.id))
}

/** Unique trigger entry points currently available for this agent. */
export function agentTriggerChars(triggers: readonly AgentNativeTrigger[]): string[] {
  return [...new Set(triggers.map((trigger) => trigger.char))]
}
