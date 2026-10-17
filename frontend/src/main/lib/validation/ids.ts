import { z } from "zod"

const projectIdPattern = /^proj_(\d+)_(\d+)_(\d+)$/
const legacyProjectIdPattern = /^proj_[0-9a-f]{32}$/
const snowflakeEpoch = 1288834974657
const snowflakeSequenceMax = 4095
const uuidV4Pattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

let lastSnowflakeTimestamp = 0
let lastSnowflakeSequence = 0

export const isSnowflakeProjectId = (value: string): boolean => {
  const match = projectIdPattern.exec(value)
  if (!match) return false

  const [, timestamp, instance, sequence] = match
  return Boolean(
    timestamp &&
      instance &&
      sequence &&
      Number(instance) <= 1023 &&
      Number(sequence) <= snowflakeSequenceMax,
  )
}

export const projectIdSchema = z
  .string()
  .refine(
    (value) => isSnowflakeProjectId(value) || legacyProjectIdPattern.test(value),
    "Invalid project ID",
  )

export const authIdSchema = z
  .string()
  .regex(uuidV4Pattern, "Invalid auth ID")

export function createSnowflakeId(prefix: "ws"): string {
  const timestamp = Date.now() - snowflakeEpoch
  const sequence =
    timestamp === lastSnowflakeTimestamp ? lastSnowflakeSequence + 1 : 0

  if (sequence > snowflakeSequenceMax) {
    throw new Error("Snowflake sequence overflow")
  }

  lastSnowflakeTimestamp = timestamp
  lastSnowflakeSequence = sequence

  return `${prefix}_${timestamp}_${String(0).padStart(3, "0")}_${String(sequence).padStart(4, "0")}`
}
