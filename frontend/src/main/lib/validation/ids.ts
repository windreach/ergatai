import { z } from "zod"

const projectIdPattern = /^proj_(\d+)_(\d+)_(\d+)$/
const legacyProjectIdPattern = /^proj_[0-9a-f]{32}$/
const snowflakeTimestampMax = 0x1ff_ffff_ffff // 41 bits
const snowflakeSequenceMax = 4095
const uuidV4Pattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

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

export const projectIdSchema = z
  .string()
  .refine(
    (value) => isSnowflakeProjectId(value) || legacyProjectIdPattern.test(value),
    "Invalid project ID",
  )

export const authIdSchema = z
  .string()
  .regex(uuidV4Pattern, "Invalid auth ID")
