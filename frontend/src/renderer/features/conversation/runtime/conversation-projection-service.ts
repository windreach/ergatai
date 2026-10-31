/**
 * Conversation Projection Service
 *
 * Converts the three message sources owned by a conversation into the single
 * render model consumed by the UI. This class is deliberately framework-free:
 * it does not know React, tRPC, transports, or DOM concerns.
 *
 * Source precedence:
 *   1. persisted messages  - backend/database canonical records
 *   2. backend runtime     - live projection of a backend-owned turn
 *   3. local transport     - freshest projection of a locally submitted turn
 *
 * The backend owns turn identity (`turnId`). A canonical message replaces all
 * ephemeral projections of the same role + turn. Before persistence lands, the
 * local transport replaces the backend runtime projection of the same turn.
 */

import type { Message, MessagePart, MessageRole } from "../../agents/stores/message-store"
import { LOCAL_TRANSPORT_STREAM_SOURCE } from "./message-correlation"

export type ConversationProjectionRawMessage = {
  id: string
  role: string
  parts?: unknown[]
  metadata?: unknown
  sequence?: number
  turnId?: string | null
  createdAt?: string | number | Date
}

export type ConversationProjectionInput = {
  persistedMessages?: Message[]
  runtimeMessages?: Message[]
  localMessages?: Message[]
}

export type ConversationProjectionResult = {
  /** Stable, ordered, renderable messages. */
  visibleMessages: Message[]
}

export interface ConversationProjectionService {
  /** Normalize a raw API/Chat message into the common projection message. */
  normalizeRawMessage(message: ConversationProjectionRawMessage): Message

  /** Project independent message sources into one visible render model. */
  project(input: ConversationProjectionInput): ConversationProjectionResult
}

type ProjectionMetadata = Record<string, unknown>

function getMetadata(message: Message): ProjectionMetadata {
  return (message.metadata && typeof message.metadata === "object"
    ? message.metadata
    : {}) as ProjectionMetadata
}

/**
 * The backend owns turn identity. Durable messages carry `turn_id` (mapped to
 * `turnId`), runtime projections carry the snapshot's `turnId`, and the local
 * transport attaches it when `TurnStarted` arrives. Legacy raw messages may
 * still expose it as a top-level field, so read both shapes.
 */
function getTurnId(message: Message): string | null {
  const metadataTurnId = getMetadata(message).turnId
  const topLevelTurnId = (message as { turnId?: unknown }).turnId
  const turnId = typeof metadataTurnId === "string" && metadataTurnId
    ? metadataTurnId
    : typeof topLevelTurnId === "string" && topLevelTurnId
      ? topLevelTurnId
      : null
  return turnId || null
}

function isEphemeralStreamProjection(message: Message): boolean {
  const metadata = getMetadata(message)
  return metadata["runtime"] === true || metadata["streamSource"] === LOCAL_TRANSPORT_STREAM_SOURCE
}

function getProjectionKey(message: Message): string | null {
  const turnId = getTurnId(message)
  return turnId ? `${message.role}:${turnId}` : null
}

/**
 * Durable user messages do not currently carry a backend turnId. The backend
 * therefore also stores the client request ID in `metadata.externalMessageId`;
 * optimistic messages carry the same ID so the canonical copy can replace them.
 */
function getExternalMessageId(message: Message): string | null {
  const externalMessageId = getMetadata(message).externalMessageId
  return typeof externalMessageId === "string" && externalMessageId
    ? externalMessageId
    : null
}

function compareMessages(a: Message, b: Message): number {
  const aSequence = a.sequence ?? Number.MAX_SAFE_INTEGER
  const bSequence = b.sequence ?? Number.MAX_SAFE_INTEGER
  if (aSequence !== bSequence) return aSequence - bSequence

  const aTime = a.createdAt?.getTime() ?? 0
  const bTime = b.createdAt?.getTime() ?? 0
  if (aTime !== bTime) return aTime - bTime

  return a.id.localeCompare(b.id)
}

class ConversationProjectionServiceImpl implements ConversationProjectionService {
  normalizeRawMessage(message: ConversationProjectionRawMessage): Message {
    const normalizedMetadata: ProjectionMetadata = {
      ...(message.metadata && typeof message.metadata === "object" && !Array.isArray(message.metadata)
        ? message.metadata
        : {}),
    }
    if (
      typeof message.turnId === "string" &&
      message.turnId &&
      !normalizedMetadata.turnId
    ) {
      normalizedMetadata.turnId = message.turnId
    }

    const runtimeSequence = normalizedMetadata.runtimeSequence
    return {
      id: message.id,
      role: message.role as MessageRole,
      parts: (message.parts ?? []) as MessagePart[],
      metadata: normalizedMetadata,
      sequence:
        typeof message.sequence === "number"
          ? message.sequence
          : typeof runtimeSequence === "number"
            ? runtimeSequence
            : undefined,
      createdAt: message.createdAt
        ? new Date(message.createdAt)
        : undefined,
    }
  }

  project(input: ConversationProjectionInput): ConversationProjectionResult {
    const messageById = new Map<string, Message>()
    const ephemeralByProjectionKey = new Map<string, Message>()
    const ephemeralByExternalMessageId = new Map<string, Message>()
    const canonicalByExternalMessageId = new Map<string, Message>()

    const findCanonicalByProjectionKey = (
      projectionKey: string,
    ): Message | undefined => {
      for (const candidate of messageById.values()) {
        if (
          !isEphemeralStreamProjection(candidate) &&
          getProjectionKey(candidate) === projectionKey
        ) {
          return candidate
        }
      }
      return undefined
    }

    const addMessage = (message: Message): void => {
      const projectionKey = getProjectionKey(message)
      const ephemeral = isEphemeralStreamProjection(message)
      const externalMessageId = getExternalMessageId(message)

      if (externalMessageId) {
        // A durable copy wins regardless of source order. This handles user
        // turns, where there is no backend TurnStarted to key the projection.
        if (ephemeral && canonicalByExternalMessageId.has(externalMessageId)) {
          return
        }
        if (!ephemeral) {
          const existingEphemeral = ephemeralByExternalMessageId.get(externalMessageId)
          if (existingEphemeral) {
            messageById.delete(existingEphemeral.id)
          }
          ephemeralByExternalMessageId.delete(externalMessageId)
          canonicalByExternalMessageId.set(externalMessageId, message)
        } else {
          ephemeralByExternalMessageId.set(externalMessageId, message)
        }
      }

      if (ephemeral && projectionKey) {
        // Never let a live projection overwrite the durable canonical copy.
        if (findCanonicalByProjectionKey(projectionKey)) return

        const existingEphemeral = ephemeralByProjectionKey.get(projectionKey)
        if (existingEphemeral) {
          messageById.delete(existingEphemeral.id)
        }
        ephemeralByProjectionKey.set(projectionKey, message)
        messageById.set(message.id, message)
        return
      }

      // A newly fetched canonical message replaces live projections of the
      // same backend turn. This is the handoff from streaming to durable data.
      if (projectionKey && ephemeralByProjectionKey.has(projectionKey)) {
        const existingEphemeral = ephemeralByProjectionKey.get(projectionKey)
        if (existingEphemeral) {
          messageById.delete(existingEphemeral.id)
        }
        ephemeralByProjectionKey.delete(projectionKey)
      }

      messageById.set(message.id, message)
    }

    for (const message of input.persistedMessages ?? []) {
      addMessage(message)
    }
    for (const message of input.runtimeMessages ?? []) {
      addMessage(message)
    }
    for (const message of input.localMessages ?? []) {
      addMessage(message)
    }

    return {
      visibleMessages: Array.from(messageById.values()).sort(compareMessages),
    }
  }
}

let serviceInstance: ConversationProjectionService | null = null

export function getConversationProjectionService(): ConversationProjectionService {
  if (!serviceInstance) {
    serviceInstance = new ConversationProjectionServiceImpl()
  }
  return serviceInstance
}

/** Test isolation / singleton reset support. */
export function resetConversationProjectionService(): void {
  serviceInstance = null
}
