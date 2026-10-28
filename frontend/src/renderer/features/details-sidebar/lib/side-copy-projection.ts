export type PersistedSideCopyMessage = {
  id: string
  role: string
  parts: unknown[]
  content?: string | null
  metadata?: Record<string, unknown> | null
  turnId?: string | null
  projectionKind?: string | null
  originMessageId?: string | null
}

export type SideMessageProjection = {
  messageId: string
  originMessageId?: string
  turnId?: string
  correlationId?: string
  text: string
}

function getMessageText(parts: unknown[]) {
  return parts
    .map(part => {
      if (!part || typeof part !== "object") return ""
      const candidate = part as { type?: unknown; text?: unknown }
      if (candidate.type !== "text") return ""
      return typeof candidate.text === "string" ? candidate.text : ""
    })
    .filter(Boolean)
    .join("\n\n")
}

export function isSideCopyProjection(message: PersistedSideCopyMessage): boolean {
  const metadata = message.metadata as
    | { sideConversationCopy?: unknown; projectionKind?: unknown }
    | null
    | undefined
  return (
    message.projectionKind === "side_copy" ||
    metadata?.projectionKind === "side_copy" ||
    metadata?.sideConversationCopy === true
  )
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function extractSentMessageId(output: unknown): string | undefined {
  const visit = (value: unknown): string | undefined => {
    if (!value || typeof value !== "object") return undefined
    const candidate = value as { message_id?: unknown; output?: unknown }
    if (typeof candidate.message_id === "string" && candidate.message_id.length > 0) {
      return candidate.message_id
    }
    if (candidate.output !== undefined) return visit(parseMaybeJson(candidate.output))
    return undefined
  }

  if (Array.isArray(output)) {
    for (const item of output) {
      const candidate = item as { text?: unknown } | null
      if (typeof candidate?.text !== "string") continue
      const messageId = extractSentMessageId(parseMaybeJson(candidate.text))
      if (messageId) return messageId
    }
  }

  return visit(output)
}

function isSendMessageToolPart(part: unknown): boolean {
  if (!part || typeof part !== "object") return false
  const type = (part as { type?: unknown }).type
  return typeof type === "string" && /send_message/i.test(type)
}

function toSideMessageProjection(
  message: PersistedSideCopyMessage,
): SideMessageProjection {
  const metadata = message.metadata as
    | { correlationId?: unknown }
    | null
    | undefined
  const structuredContent =
    typeof message.content === "string" && message.content.trim().length > 0
      ? message.content
      : undefined

  return {
    messageId: message.id,
    originMessageId: message.originMessageId ?? undefined,
    turnId: message.turnId ?? undefined,
    correlationId:
      typeof metadata?.correlationId === "string"
        ? metadata.correlationId
        : undefined,
    text: structuredContent ?? getMessageText(message.parts),
  }
}

/**
 * Side copies are persistence projections of `send_message`, not independent
 * chat messages. Move them into their producing tool call so the side transcript
 * shows one causal turn instead of reply-before-thinking.
 */
export function attachSideCopyProjectionsToTrace<T extends PersistedSideCopyMessage>(
  messages: T[],
): T[] {
  if (!messages.some(isSideCopyProjection)) return messages

  const working = messages.map(message => ({
    ...message,
    parts: [...message.parts],
  }))
  const consumedSideCopyIds = new Set<string>()

  for (const sideCopy of messages) {
    if (!isSideCopyProjection(sideCopy) || consumedSideCopyIds.has(sideCopy.id)) {
      continue
    }
    const sideMessage = toSideMessageProjection(sideCopy)

    for (const traceMessage of working) {
      if (
        isSideCopyProjection(traceMessage) ||
        consumedSideCopyIds.has(traceMessage.id)
      ) {
        continue
      }

      const partIndex = traceMessage.parts.findIndex(
        part =>
          isSendMessageToolPart(part) &&
          (!sideMessage.originMessageId ||
            extractSentMessageId((part as { output?: unknown }).output) ===
              sideMessage.originMessageId),
      )
      if (partIndex === -1) continue

      const part = traceMessage.parts[partIndex] as Record<string, unknown>
      traceMessage.parts[partIndex] = {
        ...part,
        sideMessage,
      }
      consumedSideCopyIds.add(sideCopy.id)
      break
    }
  }

  return working.filter(message => !consumedSideCopyIds.has(message.id))
}
