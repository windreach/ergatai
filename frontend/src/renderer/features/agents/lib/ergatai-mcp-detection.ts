import i18n from "@/lib/i18n"
/**
 * Shared detection helpers for Ergatai MCP tool calls.
 *
 * Different agents (Claude Code, Codex, OpenCode, ...) normalise the Ergatai
 * MCP server name in different ways (i18n.t('Ergatai MCP Tools'), "Ergatai_MCP_Tools",
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

export type SendMessageArgs = {
  target_agent_id?: string
  target_conversation_id?: string
  message?: string
  message_type?: string
  correlation_id?: string
}

const SEND_MESSAGE_NAME = /send[_-]?message/i

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function readSendMessageArgs(record: unknown): SendMessageArgs | null {
  const args = asRecord(record)
  if (!args) return null
  const parsed: SendMessageArgs = {
    target_agent_id: readNonEmptyString(args.target_agent_id),
    target_conversation_id: readNonEmptyString(args.target_conversation_id),
    message: readNonEmptyString(args.message),
    message_type: readNonEmptyString(args.message_type),
    correlation_id: readNonEmptyString(args.correlation_id),
  }
  return parsed.target_agent_id || parsed.target_conversation_id ? parsed : null
}

/**
 * Collect `toolCalls` entries from the tool-result metadata.
 *
 * Code-mode agents (e.g. OpenCode's `execute` wrapper) persist the real MCP
 * call here instead of exposing it as the part's own `input`:
 *   output: { metadata: { toolCalls: [{ tool: "Ergatai_MCP_Tools.send_message",
 *                                       input: { target_agent_id, message } }] },
 *             stdout: "{...}" }
 */
function getMetadataToolCalls(part: AnyRecord): AnyRecord[] {
  const calls: AnyRecord[] = []
  for (const candidate of [part.output, part.result, part.rawOutput]) {
    const record = asRecord(candidate)
    const metadata = record ? asRecord(record.metadata) : null
    const list = metadata?.toolCalls
    if (!Array.isArray(list)) continue
    for (const item of list) {
      const call = asRecord(item)
      if (call) calls.push(call)
    }
  }
  return calls
}

/**
 * Best-effort extraction of literal string fields from a code-mode call such
 * as `tools.Ergatai_MCP_Tools.send_message({ target_agent_id: "coder", ... })`.
 *
 * This is intentionally a literal-only parser: it never evaluates the code.
 * It is used when the tool result metadata is unavailable (e.g. a streaming
 * part that has not completed yet).
 */
function readCodeModeSendMessageArgs(code: string): SendMessageArgs | null {
  if (!SEND_MESSAGE_NAME.test(code)) return null

  const readLiteral = (key: string): string | undefined => {
    const re = new RegExp(
      `(?:^|[^\\w$])${key}\\s*:\\s*("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|\`(?:\\\\.|[^\`\\\\])*\`)`,
    )
    const match = re.exec(code)
    if (!match?.[1]) return undefined
    const raw = match[1]
    const quote = raw[0]
    const body = raw.slice(1, -1)
    if (quote === '"') {
      try {
        return JSON.parse(raw)
      } catch {
        return body
      }
    }
    return body.replace(/\\([\\'"`nrt])/g, (_m, ch: string) => {
      switch (ch) {
        case "n":
          return "\n"
        case "r":
          return "\r"
        case "t":
          return "\t"
        default:
          return ch
      }
    })
  }

  const parsed: SendMessageArgs = {
    target_agent_id: readLiteral("target_agent_id"),
    target_conversation_id: readLiteral("target_conversation_id"),
    message: readLiteral("message"),
    message_type: readLiteral("message_type"),
    correlation_id: readLiteral("correlation_id"),
  }
  return parsed.target_agent_id || parsed.target_conversation_id ? parsed : null
}

/**
 * Resolve the actual `send_message` arguments for a tool part, regardless of
 * whether the agent exposes them as the tool input, as a code-mode wrapper
 * (`input.code`), or only inside the result metadata.
 */
export function getSendMessageArgs(part: unknown): SendMessageArgs | null {
  const p = asRecord(part)
  if (!p) return null

  const direct = readSendMessageArgs(getPartInput(part))
  if (direct) return direct

  for (const call of getMetadataToolCalls(p)) {
    const toolName =
      readNonEmptyString(call.tool) ?? readNonEmptyString(call.name) ?? ""
    if (!SEND_MESSAGE_NAME.test(toolName)) continue
    const fromMetadata = readSendMessageArgs(call.input)
    if (fromMetadata) return fromMetadata
  }

  const codeInput = getPartInput(part)
  if (codeInput && typeof codeInput.code === "string") {
    return readCodeModeSendMessageArgs(codeInput.code)
  }

  return null
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

  // Code-mode agents wrap the real call in an `execute` part; the actual
  // send_message arguments live in `input.code` or the result metadata.
  if (getSendMessageArgs(part)) return true

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