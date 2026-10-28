import { z } from "zod"

const projectIdPattern = /^proj_(\d+)_(\d+)_(\d+)$/
const legacyProjectIdPattern = /^proj_[0-9a-f]{32}$/
const snowflakeIdPattern = /^(\d+)_(\d+)_(\d+)$/
const runtimeConversationPattern = /^conv-agent_[A-Za-z0-9_-]+-[A-Za-z0-9_-]+$/
const numericIdPattern = /^\d+$/
const agentIdentifierPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/
const snowflakeTimestampMax = 0x1ff_ffff_ffff // 41 bits
const snowflakeSequenceMax = 4095
const uuidV4Pattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const isSnowflakeId = (value: string): boolean => {
  const match = snowflakeIdPattern.exec(value)
  if (!match) return false

  const [, timestamp, instance, sequence] = match

  // Ensure reasonable length (timestamp: max 15 digits, instance: max 4 digits, sequence: max 4 digits)
  if (timestamp.length > 15 || instance.length > 4 || sequence.length > 4) {
    return false
  }

  const timestampValue = Number(timestamp)
  const instanceValue = Number(instance)
  const sequenceValue = Number(sequence)

  return (
    timestampValue <= snowflakeTimestampMax &&
    instanceValue <= 1023 &&
    sequenceValue <= snowflakeSequenceMax
  )
}

export const isSnowflakeProjectId = (value: string): boolean => {
  const match = projectIdPattern.exec(value)
  if (!match) return false

  const [, timestamp, instance, sequence] = match
  const timestampValue = Number(timestamp)
  const instanceValue = Number(instance)
  const sequenceValue = Number(sequence)

  return (
    timestampValue <= snowflakeTimestampMax &&
    instanceValue <= 1023 &&
    sequenceValue <= snowflakeSequenceMax
  )
}

const prefixedSnowflakeIdSchema = (prefix: string, label: string) =>
  z
    .string()
    .refine(
      (value) => value.startsWith(`${prefix}_`) && isSnowflakeId(value.slice(prefix.length + 1)),
      `Invalid ${label} ID`,
    )

export const chatIdSchema = prefixedSnowflakeIdSchema("chat", "chat")
export const conversationIdSchema = prefixedSnowflakeIdSchema("conv", "conversation")
export const workspaceIdSchema = prefixedSnowflakeIdSchema("ws", "workspace")
export const turnIdSchema = prefixedSnowflakeIdSchema("turn", "turn")

/**
 * The UI also uses runtime conversation keys for agent-to-agent turns (for
 * example `conv-agent_...-agent_...`). Those are not persisted conversation
 * IDs and must not be sent to REST endpoints expecting `conv_...`.
 */
export const conversationKeySchema = z.union([
  conversationIdSchema,
  z.string().regex(runtimeConversationPattern, "Invalid runtime conversation key"),
])

/**
 * Persisted message IDs are opaque strings emitted by the backend. Runtime
 * prompt IDs use the prefixed snowflake format.
 */
export const messageIdSchema = z
  .string()
  .refine(
    (value) =>
      numericIdPattern.test(value) ||
      (value.startsWith("msg_") && isSnowflakeId(value.slice(4))),
    "Invalid message ID",
  )

/**
 * A client request ID is always a persisted message ID (or one allocated by the
 * backend before durable persistence). Local UI IDs and random tokens must not
 * enter durable message metadata.
 */
export const clientRequestIdSchema = prefixedSnowflakeIdSchema("msg", "message")

/**
 * Agent references can be runtime IDs (`agent_...`) or configured profile
 * identifiers (`claude-code`, `opencode`, custom adapter names, and so on).
 */
export const agentIdSchema = z
  .string()
  .refine(
    (value) =>
      value.startsWith("agent_")
        ? isSnowflakeId(value.slice(6))
        : agentIdentifierPattern.test(value),
    "Invalid agent ID",
  )

export const projectIdSchema = z
  .string()
  .refine(
    (value) => isSnowflakeProjectId(value) || legacyProjectIdPattern.test(value),
    "Invalid project ID",
  )

export const isSnowflakeEntityId = isSnowflakeId

export const authIdSchema = z
  .string()
  .regex(uuidV4Pattern, "Invalid auth ID")
